import type { DeliberationRequest, ExecutionRecord, Guidance, Intent, Json, Observation, ProposalResult } from './contracts.js';
import type {
  Budget, DeliberationResponse, DueStep, GoalEvaluator, RequestKind, Run, RunEvent, RunResult, RunSpec, RunStore, StepOutcome, StepResult,
  WaitCondition,
} from './run.js';
import { dueRuns, runTerminal } from './run.js';
import type { HubOptions } from './hub.js';
import { CognitiveHub } from './hub.js';
import { MemoryRunStore, terminal } from './memory.js';
import {
  actionDigest, assertGuidance, assertIntent, assertJson, bounded, canonical, ensure, executionId, HubError, identifier, immutable, newId, text,
} from './primitives.js';

export interface RuntimeOptions extends HubOptions {
  /** Required, no default: completion needs host-queried evidence, never a decider's say-so. */
  goal: GoalEvaluator;
  runs?: RunStore;
  /** Stable identity of this worker for run ownership leases; a restarted worker with the same owner resumes its own runs. */
  owner?: string;
  leaseMs?: number;
  waitMs?: number;
}
interface Draft {
  run: Run;
  observation: Observation | null;
  /** What this step did, reported through StepResult. Set only when known (exactOptionalPropertyTypes). */
  decisionId?: string;
  recordId?: string;
  code?: string;
}
const field = (value: Json | undefined, key: string): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as { readonly [key: string]: Json })[key] : undefined;
const intentKey = (intent: Intent): string => canonical([intent.scope, intent.id]);
const stopping = (run: Run): boolean => run.stopRequested === true || run.status === 'stopping';
/**
 * The settled cursor. Missing (pre-v0.3) or malformed reads as 0, which only costs one catch-up step. A value past the end
 * can only come from an edited or corrupted snapshot; trusting it could skip an open operation, so it also reads as 0.
 */
const settledOf = (run: Run): number => {
  const value = run.settled;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= run.operations.length ? value : 0;
};
const rejected = (code: string, reason: string): RunResult => ({ kind: 'rejected', code, reason });

/**
 * Drives one Run at a time through explicit step() calls: reconcile → observe → goal → budget → propose → execute.
 * The host schedules steps and delivers events; nothing loops in the background. The single-turn hub does the work.
 */
export class IntentRuntime {
  readonly hub: CognitiveHub;
  readonly runs: RunStore;
  readonly #options: RuntimeOptions;
  readonly #now: () => number;
  readonly #owner: string;
  readonly #leaseMs: number;
  readonly #waitMs: number;
  readonly #timeout: number;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #stepping = new Map<string, string>();
  #observerErrors = 0;

  constructor(options: RuntimeOptions) {
    this.#options = { ...options };
    this.#now = options.now ?? Date.now;
    this.#owner = options.owner ?? newId();
    identifier(this.#owner, 'runtime owner');
    this.#leaseMs = options.leaseMs ?? 30000;
    this.#waitMs = options.waitMs ?? 30000;
    this.#timeout = options.decisionTimeoutMs ?? 5000;
    for (const n of [this.#leaseMs, this.#waitMs, this.#timeout])
      ensure(Number.isInteger(n) && n > 0, 'invalid-options', 'Runtime limits must be positive integers');
    this.runs = options.runs ?? new MemoryRunStore();
    const host = options.deliberation;
    // Managed requests are returned by propose(), then persisted with their Run before delivery.
    // Direct users of runtime.hub retain the single-turn provider behavior.
    this.hub = new CognitiveHub({ ...options, deliberation: { request: async request => {
      const runId = this.#stepping.get(intentKey(request.intent));
      if (runId === undefined) await host.request(request);
    } } });
  }
  get observerErrors(): number { return this.#observerErrors; }
  #emit(type: string, data: Json): void {
    try { this.#options.events?.emit(immutable({ type, at: this.#now(), data })); }
    catch { this.#observerErrors++; }
  }
  /** In-process serialization per run; across processes the ownership lease and CAS revisions do the same job. */
  async #serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const current = previous.then(task, task);
    this.#queues.set(id, current);
    try { return await current; }
    finally { if (this.#queues.get(id) === current) this.#queues.delete(id); }
  }
  async #load(id: string): Promise<Run> {
    const run = await this.runs.get(id);
    ensure(run, 'unknown-run', `Unknown run ${id}`);
    return immutable(run);
  }
  async #save(run: Run, patch: Partial<Run>): Promise<Run> {
    // Every Run the runtime holds is already deeply frozen (#load, #save, #stage, start), so only the patch is copied:
    // cloning the whole snapshot on each of a step's writes would make every write cost grow with the run's history.
    const next: Run = Object.freeze({ ...run, ...immutable(patch), revision: run.revision + 1, updatedAt: this.#now() });
    await this.runs.replace(next, run.revision);
    return next;
  }
  #budget(input: Budget): Budget {
    assertJson(input);
    for (const key of ['maxDecisions', 'maxActions', 'maxNoProgress'] as const)
      ensure(Number.isInteger(input[key]) && input[key] > 0, 'invalid-budget', `${key} must be a positive integer`);
    ensure(input.deadlineAt === null || Number.isFinite(input.deadlineAt), 'invalid-budget', 'deadlineAt must be null or a finite time');
    return immutable(input);
  }
  /** Terminal records never reopen, so only operations past the settled cursor can still be open. */
  async #open(run: Run): Promise<boolean> {
    for (const id of run.operations.slice(settledOf(run))) {
      const record = await this.hub.journal.get(id);
      if (record && !terminal(record.status)) return true;
    }
    return false;
  }

  async start(spec: RunSpec): Promise<Run> {
    assertJson(spec);
    // The same check propose() applies: an intent that fails it here would fail every later step instead.
    assertIntent(spec.intent);
    const intent = immutable(spec.intent);
    ensure(spec.approval === 'automatic' || spec.approval === 'each-action', 'invalid-run', 'approval must be automatic or each-action');
    if (spec.guidance !== undefined) assertGuidance(spec.guidance);
    const waitMs = spec.waitMs ?? this.#waitMs;
    ensure(Number.isInteger(waitMs) && waitMs > 0, 'invalid-run', 'waitMs must be a positive integer');
    const idle = spec.idle ?? 'deliberate';
    ensure(idle === 'deliberate' || idle === 'wait', 'invalid-run', 'idle must be deliberate or wait');
    const onDecisionError = spec.onDecisionError ?? 'deliberate';
    ensure(onDecisionError === 'deliberate' || onDecisionError === 'wait', 'invalid-run', 'onDecisionError must be deliberate or wait');
    const now = this.#now();
    const run: Run = immutable({
      id: newId(), revision: 0, intent, guidance: spec.guidance ?? null, budget: this.#budget(spec.budget), approval: spec.approval, waitMs, idle,
      onDecisionError,
      status: 'active', stopRequested: false, processedEvents: [], outbox: null,
      operations: [], settled: 0, wait: [], request: null, approved: null, answers: [],
      counters: { decisions: 0, actions: 0, noProgress: 0, signature: null }, progress: null, outcome: null, lease: null,
      createdAt: now, updatedAt: now,
    });
    await this.runs.create(run);
    this.#emit('run.started', { runId: run.id, intentId: intent.id });
    return run;
  }
  async get(id: string): Promise<Run | undefined> { return this.runs.get(id); }
  /**
   * Runs the host should step now, earliest first: active or stopping ones, waiting ones whose time bound has passed, and
   * undelivered notifications due for retry (see runWakeAt). Uses the store's own query when it has one.
   */
  async due(now = this.#now(), limit?: number): Promise<readonly string[]> {
    ensure(Number.isFinite(now), 'invalid-options', 'now must be a finite time');
    if (limit !== undefined) ensure(Number.isInteger(limit) && limit > 0, 'invalid-options', 'limit must be a positive integer');
    return this.runs.due ? this.runs.due(now, limit) : dueRuns(await this.runs.unsettled(), now, limit);
  }

  /**
   * One pass over the runs that are due now, earliest first, stepping at most `concurrency` of them at a time.
   * It never loops or sleeps: the host still decides when to call again. A step that throws is reported in its entry
   * instead of failing the batch. An aborted signal stops new steps from starting and is passed to the running ones.
   */
  async stepDue(options: { readonly concurrency?: number; readonly limit?: number; readonly signal?: AbortSignal } = {}): Promise<readonly DueStep[]> {
    const concurrency = options.concurrency ?? 1;
    ensure(Number.isInteger(concurrency) && concurrency > 0, 'invalid-options', 'concurrency must be a positive integer');
    const ids = await this.due(this.#now(), options.limit);
    const results: (DueStep | undefined)[] = [];
    const signal = options.signal;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length && !signal?.aborted) {
        const index = next++;
        const runId = ids[index]!;
        try { results[index] = { runId, result: await this.step(runId, signal ? { signal } : {}) }; }
        catch (error) { results[index] = { runId, error }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
    return results.filter((r): r is DueStep => r !== undefined);
  }

  /**
   * Retention in one call: decision records created, terminal runs ended, and terminal journal records settled before
   * `before`. Every journal record that an unsettled run refers to is kept, so no active run loses goal evidence or has a
   * dispatched operation mistaken for one that never happened. Records of kept finished runs older than `before` do go;
   * choose `before` older than anything still worth inspecting. A store without `prune` reports null.
   */
  async prune(options: { readonly before: number }): Promise<{ readonly decisions: number | null; readonly runs: number | null; readonly records: number | null }> {
    ensure(Number.isFinite(options.before), 'invalid-options', 'before must be a finite time');
    const retain = (await this.runs.unsettled()).flatMap(run => run.operations);
    const journal = this.hub.journal;
    const records = journal.prune ? await journal.prune(options.before, retain) : null;
    const runs = this.runs.prune ? await this.runs.prune(options.before) : null;
    const store = this.#options.decisions;
    const decisions = store?.prune ? await store.prune(options.before) : null;
    this.#emit('runtime.pruned', { before: options.before, decisions, runs, records });
    return { decisions, runs, records };
  }

  /** One bounded advance. Returns what the step ended with; the host decides when to call again. */
  async step(id: string, options: { signal?: AbortSignal } = {}): Promise<StepResult> {
    return this.#serial(id, async () => {
      let run = await this.#load(id);
      if (runTerminal(run.status) || run.status === 'paused') return { run, outcome: 'idle' };
      const now = this.#now();
      if (run.lease && run.lease.owner !== this.#owner && run.lease.expiresAt > now) return { run, outcome: 'lease-held' };
      // A quiet waiting run is checked read-only: no lease, no journal, no write unless a condition holds.
      let observation: Observation | null = null;
      if (this.#quiet(run, now)) {
        if (run.wait.some(c => c.kind === 'state')) observation = await this.#observe(run.intent, options.signal);
        const seen = observation;
        if (!seen || !run.wait.some(c => c.kind === 'state' && seen.version !== c.version)) {
          this.#emit('run.stepped', { runId: id, outcome: 'waiting', status: run.status });
          return { run, outcome: 'waiting' };
        }
      }
      try { run = await this.#save(run, { lease: { owner: this.#owner, expiresAt: now + this.#leaseMs } }); }
      catch (error) {
        if (error instanceof HubError && error.code === 'run-conflict') return { run: await this.#load(id), outcome: 'lease-held' };
        throw error;
      }
      const draft: Draft = { run, observation };
      let outcome: StepOutcome;
      try { outcome = await this.#advance(draft, options.signal); }
      finally {
        if (!runTerminal(draft.run.status) && draft.run.lease?.owner === this.#owner) {
          try { draft.run = await this.#save(draft.run, { lease: null }); } catch { /* an unreleased lease simply expires */ }
        }
      }
      this.#emit('run.stepped', { runId: id, outcome, status: draft.run.status,
        decisionId: draft.decisionId ?? null, recordId: draft.recordId ?? null, code: draft.code ?? null });
      return { run: draft.run, outcome, ...(draft.decisionId !== undefined ? { decisionId: draft.decisionId } : {}),
        ...(draft.recordId !== undefined ? { recordId: draft.recordId } : {}), ...(draft.code !== undefined ? { code: draft.code } : {}) };
    });
  }

  async #advance(draft: Draft, signal: AbortSignal | undefined): Promise<StepOutcome> {
    const save = async (patch: Partial<Run>): Promise<Run> => (draft.run = await this.#save(draft.run, patch));
    const now = this.#now();
    const hubSignal = signal ? { signal } : {};
    if (draft.run.status === 'deliberating') {
      await this.#flushOutbox(draft);
      return 'deliberating';
    }
    // 1. Reconcile what an earlier step or process left open, from the settled cursor on. Query only; never re-dispatch.
    const from = settledOf(draft.run);
    const window = draft.run.operations.slice(from);
    const records = new Map<string, ExecutionRecord>();
    for (const recordId of window) {
      let record = await this.hub.journal.get(recordId);
      if (record && !terminal(record.status)) {
        const result = await this.hub.reconcile(recordId, hubSignal);
        if (result.kind === 'record') record = result.record;
        else if (result.kind === 'rejected' && (result.code === 'unavailable-capability' || result.code === 'plugin-version-mismatch')) {
          draft.recordId = recordId; draft.code = result.code;
          return this.#deliberate(draft, 'recovery', result.reason, { recordId, code: result.code }, null);
        }
        // Other rejections (busy, reconcile-failed, journal-conflict) leave the record open; the wait retries.
      }
      if (record) records.set(recordId, record);
      // A missing record means the process died between the run write and the journal claim: nothing was dispatched.
    }
    // Phantoms are always past the cursor, so dropping them leaves the settled prefix intact.
    if (records.size !== window.length) await save({ operations: [...draft.run.operations.slice(0, from), ...records.keys()] });
    const inflight = [...records.values()].filter(r => !terminal(r.status)).map(r => r.id);
    // Leading terminal records past the cursor. The cursor moves over them once the goal has seen them.
    let lead = 0;
    for (const record of records.values()) { if (!terminal(record.status)) break; lead++; }
    const settled: Partial<Run> = lead ? { settled: from + lead } : {};
    if (stopping(draft.run)) {
      // A stopping run never consults the goal again, so its cursor moves here.
      if (inflight.length) { await save({ ...settled, wait: this.#waitFor(draft.run, inflight, now), lease: null }); return 'waiting'; }
      return this.#finish(draft, 'stopped', draft.run.outcome ?? { code: 'stopped', reason: 'Stopped by host', evidence: null });
    }
    // 2. Observe once here (or reuse the quiet check's observation); propose reuses it, execute observes again.
    const observation = draft.observation && draft.observation.validUntil > this.#now()
      ? draft.observation : await this.#observe(draft.run.intent, signal);
    // 3. A waiting run continues only when a registered condition holds. No decider call otherwise.
    if (draft.run.status === 'waiting') {
      const holds = (c: WaitCondition): boolean => c.kind === 'time' ? now >= c.at
        : c.kind === 'state' ? observation.version !== c.version
        : c.kind === 'execution' ? !records.has(c.recordId) || terminal(records.get(c.recordId)!.status)
        : false;
      if (!draft.run.wait.some(holds)) return 'waiting';
      const progressed = draft.run.wait.some(c => c.kind !== 'time' && holds(c));
      const counters = draft.run.counters;
      // Staged like the goal's fields below; if the goal throws, step()'s lease release persists it as before.
      this.#stage(draft, { status: 'active', wait: [], counters: progressed ? counters : { ...counters, noProgress: counters.noProgress + 1 } });
    }
    // 4. The goal is judged on independent evidence before any action, including the first one.
    const goal = await bounded(this.#timeout, signal, s => this.#options.goal.evaluate(
      { intent: draft.run.intent, observation, records: [...records.values()], operations: draft.run.operations }, s));
    assertJson(goal);
    ensure(goal.status === 'satisfied' || goal.status === 'unsatisfied' || goal.status === 'unreachable', 'invalid-goal', 'Unknown goal status');
    const progress = goal.progress === undefined ? draft.run.progress : goal.progress;
    // Staged, not written: every path from here on ends in a save that carries them.
    this.#stage(draft, { ...settled, ...(canonical(progress) !== canonical(draft.run.progress) ? { progress } : {}) });
    if (goal.status === 'satisfied') {
      // Never complete with an unknown outcome in flight.
      if (inflight.length) { await save({ status: 'waiting', wait: this.#waitFor(draft.run, inflight, now), lease: null }); return 'waiting'; }
      return this.#finish(draft, 'completed', { code: 'satisfied', reason: 'The goal evaluator confirmed the objective', evidence: goal.evidence });
    }
    if (goal.status === 'unreachable') {
      // Failure ends scheduling too; accepted work must remain owned until it settles.
      if (inflight.length) { await save({ status: 'waiting', wait: this.#waitFor(draft.run, inflight, now), lease: null }); return 'waiting'; }
      return this.#finish(draft, 'failed', { code: 'unreachable', reason: 'The goal evaluator judged the objective unreachable', evidence: goal.evidence });
    }
    // 5. One action at a time.
    if (inflight.length) { await save({ status: 'waiting', wait: this.#waitFor(draft.run, inflight, now), lease: null }); return 'waiting'; }
    // 6. Budgets are checked before the decider is called.
    const { budget, counters } = draft.run;
    if (budget.deadlineAt !== null && this.#now() >= budget.deadlineAt)
      return this.#deliberate(draft, 'budget', 'The run deadline has passed', { deadlineAt: budget.deadlineAt }, observation.version);
    if (counters.decisions >= budget.maxDecisions)
      return this.#deliberate(draft, 'budget', 'The decision budget is exhausted', { decisions: counters.decisions }, observation.version);
    if (counters.actions >= budget.maxActions)
      return this.#deliberate(draft, 'budget', 'The action budget is exhausted', { actions: counters.actions }, observation.version);
    if (counters.noProgress >= budget.maxNoProgress)
      return this.#deliberate(draft, 'no-progress', 'Repeated decisions made no progress', { noProgress: counters.noProgress }, observation.version);
    // 7. Decide through the single-turn hub.
    await save({ counters: { ...counters, decisions: counters.decisions + 1 } });
    const key = intentKey(draft.run.intent);
    this.#stepping.set(key, draft.run.id);
    let proposal: ProposalResult;
    try {
      proposal = await this.hub.propose(draft.run.intent,
        { ...hubSignal, ...(draft.run.guidance ? { guidance: draft.run.guidance } : {}), tags: { runId: draft.run.id }, observation,
          // An idle run treats an empty candidate set as "nothing to do yet" and waits for the state to change.
          ...(draft.run.idle === 'wait' ? { onEmpty: 'wait' as const } : {}),
          ...(draft.run.onDecisionError === 'wait' ? { onDecisionError: 'wait' as const } : {}) });
    }
    finally { this.#stepping.delete(key); }
    if (proposal.decisionId !== undefined) draft.decisionId = proposal.decisionId;
    if (proposal.kind === 'wait') {
      if (proposal.code !== undefined) draft.code = proposal.code;
      // A failed decision counts as no progress however the state moves (a real-time host changes it every frame), and
      // leaves the signature alone so an interleaved failure cannot hide a repeated same-action loop.
      const failed = proposal.code !== undefined && proposal.code !== 'aborted';
      const c = draft.run.counters;
      await save({ status: 'waiting', wait: [{ kind: 'state', version: observation.version }, { kind: 'time', at: now + draft.run.waitMs }],
        counters: failed ? { ...c, noProgress: c.noProgress + 1 } : this.#count(c, canonical([observation.version, 'wait'])), lease: null });
      this.#emit('run.waiting', { runId: draft.run.id, reason: proposal.reason, code: proposal.code ?? null });
      return 'waiting';
    }
    if (proposal.kind === 'deliberation') {
      // The hub's structured subject says why (no candidates, the decider asked, or which phase failed with which code).
      const subject = proposal.request.subject ?? null;
      const failed = field(subject ?? null, 'cause') === 'failed' ? field(subject ?? null, 'code') : undefined;
      if (typeof failed === 'string') draft.code = failed;
      return this.#parkRequest(draft, 'decision', immutable({ ...proposal.request,
        runId: draft.run.id, kind: 'decision', subject }));
    }
    try {
      // Recheck the Run deadline after every slow decision; hub.execute enforces it again after preflight/claim.
      if (budget.deadlineAt !== null && this.#now() >= budget.deadlineAt)
        return this.#deliberate(draft, 'budget', 'The run deadline has passed', { deadlineAt: budget.deadlineAt }, proposal.stateVersion);
      // 8. Approval gate: an approval names one action digest at one state version and is spent by use.
      const { action } = proposal;
      const digest = actionDigest(action);
      if (draft.run.approval === 'each-action') {
        const approved = draft.run.approved;
        const valid = approved !== null && approved.digest === digest && approved.stateVersion === proposal.stateVersion && approved.expiresAt > this.#now();
        if (!valid) {
          if (approved) await save({ approved: null });
          return this.#deliberate(draft, 'approval', 'Host approval is required before this action is dispatched',
            { digest, stateVersion: proposal.stateVersion, capability: action.capability, description: action.description,
              input: action.input, resources: action.resources }, proposal.stateVersion);
        }
      }
      const deadlineAt = Math.min(budget.deadlineAt ?? Infinity,
        draft.run.approval === 'each-action' ? draft.run.approved!.expiresAt : Infinity);
      // 9. Persist the operation before dispatch, so a crash in between is recovered by lookup, never by re-dispatch.
      const operationId = `${draft.run.id}/${draft.run.counters.actions + 1}`;
      const recordId = executionId(draft.run.intent, operationId);
      await save({ operations: [...draft.run.operations, recordId], approved: null,
        counters: { ...this.#count(draft.run.counters, canonical([observation.version, action.id])), actions: draft.run.counters.actions + 1 } });
      const execution = await this.hub.execute(proposal.id, operationId, { live: true, ...hubSignal,
        ...(Number.isFinite(deadlineAt) ? { deadlineAt } : {}) });
      if (execution.kind === 'rejected') {
        draft.code = execution.code;
        this.#emit('run.dispatch.rejected', { runId: draft.run.id, code: execution.code });
        const c = draft.run.counters;
        await save({ operations: draft.run.operations.filter(x => x !== recordId), counters: { ...c, noProgress: c.noProgress + 1 }, lease: null });
        return 'rejected';
      }
      ensure(execution.kind === 'record', 'invalid-execution', 'Live execution cannot return a preview');
      draft.recordId = recordId;
      // The executed path keeps the lease until step() releases it: the operation id was written before dispatch.
      if (terminal(execution.record.status)) return 'executed';
      await save({ status: 'waiting', wait: this.#waitFor(draft.run, [recordId], now), lease: null });
      return 'waiting';
    } finally {
      // The runtime owns this proposal; persisted executions are recovered from the journal.
      this.hub.discard(proposal.id);
    }
  }
  /** Waiting on state or time only, nothing open, no lease to clear and no time bound reached: nothing to reconcile. */
  #quiet(run: Run, now: number): boolean {
    return run.status === 'waiting' && !stopping(run) && run.lease === null && settledOf(run) === run.operations.length &&
      run.wait.length > 0 && run.wait.every(c => c.kind === 'state' || (c.kind === 'time' && now < c.at));
  }
  /** Carry fields into the step's next save without writing now. The revision is unchanged, so that save's CAS still holds. */
  #stage(draft: Draft, patch: Partial<Run>): void {
    if (Object.keys(patch).length) draft.run = Object.freeze({ ...draft.run, ...immutable(patch) });
  }
  #count(counters: Run['counters'], signature: string): Run['counters'] {
    return signature === counters.signature ? { ...counters, noProgress: counters.noProgress + 1 } : { ...counters, noProgress: 0, signature };
  }
  #waitFor(run: Run, inflight: readonly string[], now: number): readonly WaitCondition[] {
    return [...inflight.map(recordId => ({ kind: 'execution' as const, recordId })), { kind: 'time' as const, at: now + run.waitMs }];
  }
  async #observe(intent: Intent, signal: AbortSignal | undefined): Promise<Observation> {
    const raw = await bounded(this.#timeout, signal, s => this.#options.state.observe(intent, s));
    assertJson(raw);
    const observation = immutable(raw);
    identifier(observation.version, 'state version');
    ensure(Number.isFinite(observation.validUntil) && observation.validUntil > this.#now(), 'stale-state', 'Observation is stale or invalid');
    return observation;
  }
  async #finish(draft: Draft, status: 'completed' | 'failed' | 'stopped', outcome: NonNullable<Run['outcome']>): Promise<StepOutcome> {
    draft.run = await this.#save(draft.run, { status, wait: [], request: null, outbox: null, approved: null, outcome, lease: null });
    this.#emit(`run.${status}`, { runId: draft.run.id, code: outcome.code });
    return status;
  }
  async #deliberate(draft: Draft, kind: RequestKind, reason: string, subject: Json, stateVersion: string | null): Promise<StepOutcome> {
    const run = draft.run;
    return this.#parkRequest(draft, kind, immutable({ id: newId(), intent: run.intent, stateVersion, reason,
      createdAt: this.#now(), runId: run.id, kind, subject }));
  }
  /** The waiting state and full notification form one transaction in the Run store (inline outbox). */
  async #parkRequest(draft: Draft, kind: RequestKind, message: DeliberationRequest): Promise<StepOutcome> {
    const run = draft.run;
    draft.run = await this.#save(run, { status: 'deliberating', stopRequested: stopping(run),
      request: { id: message.id, kind, subject: message.subject ?? null },
      wait: [{ kind: 'deliberation', requestId: message.id }],
      outbox: { message, delivered: false, retryAt: this.#now() } });
    await this.#flushOutbox(draft);
    this.#emit('run.deliberating', { runId: run.id, requestId: message.id, kind });
    return 'deliberating';
  }
  /** At-least-once with a stable ID. The provider must deduplicate if delivery succeeds but acknowledgment is lost. */
  async #flushOutbox(draft: Draft): Promise<void> {
    const item = draft.run.outbox;
    if (!item || item.delivered || draft.run.request?.id !== item.message.id) return;
    const pending = { ...item, retryAt: this.#now() + draft.run.waitMs };
    draft.run = await this.#save(draft.run, { outbox: pending });
    // On either delivery or acknowledgment failure, the original message remains recoverable.
    await bounded(this.#timeout, undefined, () => this.#options.deliberation.request(item.message));
    draft.run = await this.#save(draft.run, { outbox: { ...pending, delivered: true } });
  }

  /** Hand the run an external event. Duplicates and events after the end are ignored; a matching event wakes a waiting run. */
  async deliver(id: string, event: RunEvent): Promise<{ readonly accepted: boolean; readonly woke: boolean }> {
    assertJson(event); identifier(event.key, 'event key');
    return this.#serial(id, async () => {
      const run = await this.#load(id);
      if ((run.processedEvents ?? []).includes(event.key)) {
        this.#emit('run.event.duplicate', { runId: id, key: event.key }); return { accepted: false, woke: false };
      }
      if (runTerminal(run.status)) {
        this.#emit('run.event.ignored', { runId: id, key: event.key, status: run.status }); return { accepted: false, woke: false };
      }
      const now = this.#now();
      const woke = (run.status === 'waiting' || run.status === 'stopping') && (event.type === 'host' || run.wait.some(c =>
        c.kind === 'state' ? event.type === 'state-changed' && field(event.data, 'version') !== c.version
        : c.kind === 'execution' ? event.type === 'execution-updated' && field(event.data, 'recordId') === c.recordId
        : c.kind === 'time' ? event.type === 'timer' && now >= c.at : false));
      // No separate markEvent write: a failed CAS consumes nothing, and a lost acknowledgment is safely deduplicated.
      await this.#save(run, { processedEvents: [...(run.processedEvents ?? []), event.key],
        ...(woke && run.status === 'waiting' ? { status: stopping(run) ? 'stopping' as const : 'active' as const, wait: [] } : {}) });
      if (!woke) return { accepted: true, woke: false };
      this.#emit('run.woken', { runId: id, key: event.key, type: event.type });
      return { accepted: true, woke: true };
    });
  }

  /** Apply an authenticated response to the open request. The host authenticates; the runtime only checks it fits. */
  async respond(id: string, response: DeliberationResponse): Promise<RunResult> {
    assertJson(response as unknown); // Validate the shape without narrowing the discriminated union.
    return this.#serial(id, async () => {
      const run = await this.#load(id);
      const reject = (code: string, reason: string): RunResult => { this.#emit('run.response.rejected', { runId: id, code }); return rejected(code, reason); };
      if (runTerminal(run.status)) return reject('run-terminal', 'The run has already ended');
      if (!run.request || run.request.id !== response.requestId) return reject('stale-response', 'The response does not answer the open request');
      if (response.intentRevision !== run.intent.revision) return reject('stale-response', 'The response refers to another intent revision');
      const resumed = run.status === 'paused' ? 'paused' : stopping(run) ? 'stopping' : 'active';
      let patch: Partial<Run>;
      switch (response.kind) {
        case 'fact':
          patch = { status: resumed, request: null, wait: [] }; break;
        case 'guidance':
          assertGuidance(response.guidance);
          if (response.guidance.version !== (run.guidance?.version ?? 0) + 1) return reject('stale-guidance', 'Guidance version must increase by one');
          patch = { status: resumed, request: null, wait: [], guidance: response.guidance }; break;
        case 'approve': {
          if (run.request.kind !== 'approval') return reject('approval-mismatch', 'The open request is not an approval request');
          if (response.digest !== field(run.request.subject, 'digest') || response.stateVersion !== field(run.request.subject, 'stateVersion'))
            return reject('approval-mismatch', 'An approval must name the requested action and state version');
          ensure(Number.isFinite(response.expiresAt), 'invalid-response', 'Approval expiry must be finite');
          patch = { status: resumed, request: null, wait: [], approved: { digest: response.digest, stateVersion: response.stateVersion, expiresAt: response.expiresAt } };
          break;
        }
        case 'terminate': {
          text(response.reason, 'termination reason');
          const outcome = { code: 'terminated', reason: response.reason, evidence: null };
          patch = (await this.#open(run)) ? { status: 'stopping', stopRequested: true, request: null, wait: [], approved: null, outcome }
            : { status: 'stopped', stopRequested: true, request: null, wait: [], approved: null, outcome, lease: null };
          break;
        }
        default: return reject('invalid-response', 'Unknown response kind');
      }
      const next = await this.#save(run, { ...patch, outbox: null, answers: [...run.answers, { requestId: response.requestId, kind: response.kind, at: this.#now() }] });
      this.#emit('run.response.applied', { runId: id, requestId: response.requestId, kind: response.kind, status: next.status });
      if (next.status === 'stopped') this.#emit('run.stopped', { runId: id, code: 'terminated' });
      return { kind: 'applied', run: next };
    });
  }

  async pause(id: string): Promise<RunResult> {
    return this.#serial(id, async () => {
      const run = await this.#load(id);
      if (runTerminal(run.status) || stopping(run)) return rejected('run-state', `A ${run.status} run cannot be paused`);
      if (run.status === 'paused') return { kind: 'applied', run };
      const next = await this.#save(run, { status: 'paused', wait: [] });
      this.#emit('run.paused', { runId: id });
      return { kind: 'applied', run: next };
    });
  }
  /** Resumes to active (re-observe) or back to deliberating when a request is still open. */
  async resume(id: string): Promise<RunResult> {
    return this.#serial(id, async () => {
      const run = await this.#load(id);
      if (run.status !== 'paused') return rejected('run-state', 'Only a paused run can be resumed');
      const next = await this.#save(run, { status: run.request ? 'deliberating' : stopping(run) ? 'stopping' : 'active' });
      this.#emit('run.resumed', { runId: id, status: next.status });
      return { kind: 'applied', run: next };
    });
  }
  /** Stop issuing actions. Open operations keep being reconciled until settled; nothing external is undone. */
  async stop(id: string): Promise<RunResult> {
    return this.#serial(id, async () => {
      const run = await this.#load(id);
      if (runTerminal(run.status)) return rejected('run-terminal', 'The run has already ended');
      if (run.status === 'stopping') return { kind: 'applied', run };
      const outcome = { code: 'stopped', reason: 'Stopped by host', evidence: null };
      const next = (await this.#open(run))
        ? await this.#save(run, { status: 'stopping', stopRequested: true, request: null, outbox: null, approved: null, wait: [], outcome })
        : await this.#save(run, { status: 'stopped', stopRequested: true, request: null, outbox: null, approved: null, wait: [], outcome, lease: null });
      this.#emit(next.status === 'stopped' ? 'run.stopped' : 'run.stopping', { runId: id, code: outcome.code });
      return { kind: 'applied', run: next };
    });
  }
  /** Host-authenticated changes to the delegation itself. A new intent revision invalidates open requests and approvals. */
  async revise(id: string, patch: { readonly intent?: Intent; readonly budget?: Partial<Budget>; readonly guidance?: Guidance }): Promise<RunResult> {
    assertJson(patch);
    return this.#serial(id, async () => {
      const run = await this.#load(id);
      if (runTerminal(run.status)) return rejected('run-terminal', 'The run has already ended');
      let changes: Partial<Run> = {};
      if (patch.intent !== undefined) {
        assertIntent(patch.intent);
        const intent = immutable(patch.intent);
        if (intent.id !== run.intent.id || canonical(intent.scope) !== canonical(run.intent.scope))
          return rejected('intent-mismatch', 'A revision must keep the intent id and scope');
        if (!Number.isInteger(intent.revision) || intent.revision <= run.intent.revision) return rejected('stale-intent', 'Intent revision must increase');
        changes = { ...changes, intent, request: null, outbox: null, approved: null, wait: [], counters: { ...run.counters, noProgress: 0, signature: null },
          status: run.status === 'paused' ? 'paused' : stopping(run) ? 'stopping' : 'active' };
      }
      if (patch.budget !== undefined) {
        changes = { ...changes, budget: this.#budget({ ...run.budget, ...patch.budget }) };
        // A revised budget answers a budget request by itself; other requests still need a response.
        if (run.request?.kind === 'budget' && changes.request === undefined)
          changes = { ...changes, request: null, outbox: null, wait: [], status: run.status === 'paused' ? 'paused' : stopping(run) ? 'stopping' : 'active' };
      }
      if (patch.guidance !== undefined) {
        assertGuidance(patch.guidance);
        if (patch.guidance.version !== (run.guidance?.version ?? 0) + 1) return rejected('stale-guidance', 'Guidance version must increase by one');
        changes = { ...changes, guidance: patch.guidance };
      }
      const next = await this.#save(run, changes);
      this.#emit('run.revised', { runId: id, intentRevision: next.intent.revision, guidanceVersion: next.guidance?.version ?? null });
      return { kind: 'applied', run: next };
    });
  }
}
