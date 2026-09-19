import type {
  BoundAction, Decision, DecisionProvider, DecisionRequest, DeliberationProvider,
  EventSink, ExecutionContext, ExecutionJournal, ExecutionRecord, ExecutionResult,
  Guidance, Intent, Json, Observation, Policy, ProposalResult, Receipt, StateProvider, Verification,
} from './contracts.js';
import type { CapabilityLease } from './plugins.js';
import { PluginHost } from './plugins.js';
import { MemoryJournal, terminal } from './memory.js';
import {
  actionIdentity, assertGuidance, assertJson, assertReceipt, assertRecord, bounded, canonical, ensure, executionId, HubError, identifier,
  immutable, newId, validScope,
} from './primitives.js';

interface Proposal {
  id: string;
  intent: Intent;
  observation: Observation;
  action: BoundAction;
  decision: Decision;
  policyVersion: string;
  expiresAt: number;
}
interface Pending {
  readonly lease: CapabilityLease;
  readonly context: ExecutionContext;
  callbacks: number;
  terminal: boolean;
}
type Patch = Partial<Pick<ExecutionRecord, 'status' | 'receipt' | 'evidence'>>;
export interface HubOptions {
  plugins: PluginHost;
  state: StateProvider;
  decision: DecisionProvider;
  /** Required: no implicit allow-all policy. */
  policy: Policy;
  deliberation: DeliberationProvider;
  journal?: ExecutionJournal;
  events?: EventSink;
  proposalTtlMs?: number;
  decisionTimeoutMs?: number;
  executionTimeoutMs?: number;
  maxCandidates?: number;
  maxProposals?: number;
  now?: () => number;
}
const rejected = (code: string, reason: string): ExecutionResult => ({ kind: 'rejected', code, reason });

/** One bounded turn at a time. The host owns scheduling, goals, authority and physical safety. */
export class CognitiveHub {
  readonly #options: HubOptions;
  readonly journal: ExecutionJournal;
  readonly #proposals = new Map<string, Proposal>();
  readonly #planning = new Set<string>();
  readonly #executing = new Set<string>();
  readonly #executingProposals = new Set<string>();
  readonly #consumed = new Map<string, string>();
  readonly #pending = new Map<string, Pending>();
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #decisionTimeout: number;
  readonly #executionTimeout: number;
  readonly #maxCandidates: number;
  readonly #maxProposals: number;
  #observerErrors = 0;

  constructor(options: HubOptions) {
    this.#options = { ...options };
    this.journal = options.journal ?? new MemoryJournal();
    this.#now = options.now ?? Date.now;
    this.#ttl = options.proposalTtlMs ?? 3000;
    this.#decisionTimeout = options.decisionTimeoutMs ?? 5000;
    this.#executionTimeout = options.executionTimeoutMs ?? 5000;
    this.#maxCandidates = options.maxCandidates ?? 64;
    this.#maxProposals = options.maxProposals ?? 256;
    for (const n of [this.#ttl, this.#decisionTimeout, this.#executionTimeout, this.#maxCandidates, this.#maxProposals])
      ensure(Number.isInteger(n) && n > 0, 'invalid-options', 'Limits must be positive integers');
  }
  get observerErrors(): number { return this.#observerErrors; }
  #emit(type: string, data: Json): void {
    try { this.#options.events?.emit(immutable({ type, at: this.#now(), data })); }
    catch { this.#observerErrors++; } // Observers cannot veto or change execution.
  }
  #intent(input: Intent): Intent {
    assertJson(input);
    const intent = immutable(input);
    identifier(intent.id, 'intent id'); identifier(intent.objective, 'objective'); validScope(intent.scope);
    ensure(Number.isInteger(intent.revision) && intent.revision >= 1, 'invalid-intent', 'Revision must be positive');
    ensure(Array.isArray(intent.constraints) && intent.constraints.every(x => typeof x === 'string'),
      'invalid-intent', 'Constraints must be strings');
    ensure(Array.isArray(intent.capabilities), 'invalid-intent', 'Capabilities must be an array');
    intent.capabilities.forEach(x => identifier(x, 'capability id'));
    return intent;
  }
  #observation(input: Observation): Observation {
    assertJson(input);
    const observation = immutable(input);
    identifier(observation.version, 'state version');
    assertJson(observation.facts as unknown);
    ensure(Number.isFinite(observation.observedAt) && Number.isFinite(observation.validUntil) &&
      observation.observedAt <= this.#now() && observation.validUntil > this.#now() &&
      observation.validUntil >= observation.observedAt, 'stale-state', 'Observation is stale or invalid');
    return observation;
  }
  async #ask(intent: Intent, reason: string, stateVersion: string | null): Promise<ProposalResult> {
    const request = immutable({ id: newId(), intent, stateVersion, reason, createdAt: this.#now() });
    await this.#options.deliberation.request(request);
    this.#emit('deliberation.requested', { requestId: request.id, intentId: intent.id, reason });
    return { kind: 'deliberation', request };
  }

  async propose(input: Intent, options: { signal?: AbortSignal; guidance?: Guidance } = {}): Promise<ProposalResult> {
    const intent = this.#intent(input);
    const guidance = options.guidance;
    if (guidance !== undefined) assertGuidance(guidance);
    const session = canonical([intent.scope, intent.id]);
    if (this.#planning.has(session)) return { kind: 'wait', reason: 'A decision is already in flight for this intent' };
    this.#planning.add(session);
    const leases: CapabilityLease[] = [];
    let stateVersion: string | null = null;
    let began = false;
    let asking = false;
    try {
      return await bounded(this.#decisionTimeout, options.signal, async signal => {
        began = true;
        try {
          const observation = this.#observation(await this.#options.state.observe(intent, signal));
          stateVersion = observation.version;
          signal.throwIfAborted();
          const prepared: BoundAction[] = [];
          for (const registration of this.#options.plugins.list(intent.scope)) {
            if (!intent.capabilities.includes(registration.capability.id)) continue;
            const lease = this.#options.plugins.acquire(registration.pluginId,
              registration.capability.id, registration.activation, intent.scope);
            leases.push(lease);
            const capability = lease.registration.capability;
            const drafts = await capability.prepare({ intent, observation, signal });
            signal.throwIfAborted();
            ensure(Array.isArray(drafts as unknown), 'invalid-candidate', 'Candidate builder must return an array');
            const keys = new Set<string>();
            for (const draft of drafts) {
              assertJson(draft as unknown); identifier(draft.key, 'candidate key'); identifier(draft.description, 'candidate description');
              ensure(!keys.has(draft.key), 'duplicate-candidate', 'Candidate keys must be unique within a capability');
              keys.add(draft.key);
              ensure(Array.isArray(draft.resources), 'invalid-candidate', 'Resources must be an array');
              draft.resources.forEach(r => identifier(r, 'resource id'));
              ensure(new Set(draft.resources).size === draft.resources.length &&
                (capability.effect === 'read' || draft.resources.length > 0), 'invalid-candidate', 'Writes require unique resource IDs');
              capability.validate(draft.input);
              // Plugin IDs are unique per host and keys per capability, so the id needs no activation to be unique.
              prepared.push(immutable({ ...draft,
                id: canonical([registration.pluginId, capability.id, draft.key]),
                pluginId: registration.pluginId, pluginVersion: registration.pluginVersion,
                activation: registration.activation, capability: capability.id,
                effect: capability.effect, scope: intent.scope,
              }));
              ensure(prepared.length <= this.#maxCandidates, 'candidate-limit', 'Too many candidates; narrow the capability adapters');
            }
          }
          // Policy judges each action against the whole bound set, not one candidate at a time.
          const candidates: BoundAction[] = [];
          const policyVersions = new Map<string, string>();
          for (const action of prepared) {
            const policy = await this.#options.policy.check({ intent, observation, candidates: prepared, action, phase: 'propose' }, signal);
            signal.throwIfAborted(); identifier(policy.version, 'policy version');
            if (policy.allowed !== true) continue;
            candidates.push(action); policyVersions.set(action.id, policy.version);
          }
          if (!candidates.length) return { kind: 'deliberate' as const, reason: 'No authorized, applicable capability candidates' };
          const request: DecisionRequest = immutable({ intent, observation, candidates, ...(guidance ? { guidance } : {}) });
          const decision = immutable(await this.#options.decision.decide(request, signal));
          assertJson(decision); signal.throwIfAborted();
          ensure(observation.validUntil > this.#now(), 'stale-state', 'State expired while deciding');
          this.#emit('decision.received', { intentId: intent.id, provider: this.#options.decision.name, kind: decision.kind });
          if (decision.kind === 'wait' || decision.kind === 'deliberate') identifier(decision.reason, 'decision reason');
          if (decision.kind === 'wait') return { kind: 'wait' as const, reason: decision.reason };
          if (decision.kind === 'deliberate') return decision;
          ensure(decision.kind === 'action', 'invalid-decision', 'Unknown decision kind');
          const action = candidates.find(c => c.id === decision.candidateId);
          ensure(action, 'invalid-decision', 'Model selected an unknown candidate');
          const proposal: Proposal = immutable({ id: newId(), intent, observation, action, decision,
            policyVersion: policyVersions.get(action.id)!, expiresAt: Math.min(observation.validUntil, this.#now() + this.#ttl) });
          for (const [id, existing] of this.#proposals) if (existing.expiresAt <= this.#now()) this.discard(id);
          ensure(this.#proposals.size < this.#maxProposals, 'proposal-limit', 'Consume/discard outstanding proposals before creating more');
          this.#proposals.set(proposal.id, proposal);
          this.#emit('proposal.created', { proposalId: proposal.id, intentId: intent.id, capability: action.capability });
          return { kind: 'proposal' as const, id: proposal.id, action, expiresAt: proposal.expiresAt, decision, stateVersion: observation.version };
        } finally { leases.reverse().forEach(l => l.release()); this.#planning.delete(session); }
      }).then(result => {
        if (result.kind !== 'deliberate') return result;
        asking = true;
        return this.#ask(intent, result.reason, stateVersion);
      });
    } catch (error) {
      if (asking) throw error;
      if (options.signal?.aborted) return { kind: 'wait', reason: 'Decision cancelled by host' };
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'decision-unavailable';
      this.#emit('decision.rejected', { intentId: intent.id, code });
      return await this.#ask(intent, code, stateVersion);
    } finally { if (!began) this.#planning.delete(session); }
  }

  discard(proposalId: string): boolean { this.#consumed.delete(proposalId); return this.#proposals.delete(proposalId); }

  async execute(proposalId: string, operationId: string,
    options: { live?: boolean; signal?: AbortSignal } = {}): Promise<ExecutionResult> {
    identifier(operationId, 'operation id');
    const proposal = this.#proposals.get(proposalId);
    if (!proposal) return rejected('unknown-proposal', 'Unknown or discarded proposal');
    const { intent, action } = proposal;
    const id = executionId(intent, operationId);
    // Identity excludes the process-local activation, so a retry after a restart finds its own record.
    const fingerprint = canonical({ intent, action: actionIdentity(action) });
    if (this.#executingProposals.has(proposalId)) return rejected('busy', 'Proposal is already being handled');
    if (this.#consumed.has(proposalId) && this.#consumed.get(proposalId) !== id)
      return rejected('proposal-consumed', 'Proposal already belongs to another operation');
    if (this.#executing.has(id)) return rejected('busy', 'Operation is already being handled');
    this.#executing.add(id);
    this.#executingProposals.add(proposalId);
    let preflight: Promise<ExecutionContext> | undefined;
    let lease: CapabilityLease | undefined;
    let retained = false;
    try {
      const existing = await this.journal.get(id);
      if (existing) return existing.fingerprint === fingerprint
        ? { kind: 'record', record: existing, unchanged: true }
        : rejected('operation-mismatch', 'Operation ID already belongs to another action');
      ensure(proposal.expiresAt > this.#now(), 'stale-proposal', 'Proposal has expired');
      lease = this.#options.plugins.acquire(action.pluginId, action.capability, action.activation, intent.scope);
      const capability = lease.registration.capability;
      const context = await bounded(this.#executionTimeout, options.signal, signal => {
        preflight = (async (): Promise<ExecutionContext> => {
        const observation = this.#observation(await this.#options.state.observe(intent, signal));
        ensure(observation.version === proposal.observation.version, 'stale-state', 'State changed since decision');
        const policy = await this.#options.policy.check({ intent, observation, candidates: [action], action, phase: 'execute' }, signal);
        ensure(policy.allowed === true && policy.version === proposal.policyVersion,
          'policy-rejected', 'Authorization was denied or changed');
        capability.validate(action.input);
        const ctx: ExecutionContext = Object.freeze({ intent, observation, action, operationId, idempotencyKey: id, signal });
        ensure(await capability.check(ctx), 'precondition', 'Capability preconditions no longer hold');
        const finalPolicy = await this.#options.policy.check({ intent, observation, candidates: [action], action, phase: 'execute' }, signal);
        ensure(finalPolicy.allowed === true && finalPolicy.version === proposal.policyVersion,
          'policy-rejected', 'Authorization changed during preflight');
        signal.throwIfAborted();
        ensure(this.#options.plugins.status(action.pluginId) === 'active', 'capability-draining', 'Plugin is stopping');
        ensure(proposal.expiresAt > this.#now() && observation.validUntil > this.#now(), 'stale-proposal', 'Proposal expired in preflight');
        return ctx;
        })();
        return preflight;
      });
      if (options.live !== true) {
        this.#emit('execution.previewed', { proposalId, operationId });
        return { kind: 'dry-run', action };
      }
      const created = this.#now();
      let record: ExecutionRecord = immutable({ id, revision: 0, operationId, fingerprint, intent,
        observation: context.observation, action, status: 'submitted', receipt: null, evidence: null,
        createdAt: created, updatedAt: created });
      const claim = await this.journal.claim(record);
      if (claim.kind === 'existing') return { kind: 'record', record: claim.record, unchanged: true };
      if (claim.kind === 'conflict') return rejected('claim-conflict', claim.reason);
      // Retain the plugin and resources until a terminal result is durably recorded.
      retained = true;
      this.#consumed.set(proposalId, id);
      const pending: Pending = { lease, context, callbacks: 0, terminal: false };
      this.#pending.set(id, pending);
      this.#emit('execution.submitted', { id, operationId, capability: action.capability });
      let receipt: Receipt;
      const now = this.#now();
      const rejection = options.signal?.aborted ? 'cancelled'
        : proposal.expiresAt <= now ? 'proposal-expired'
        : context.observation.validUntil <= now ? 'observation-expired'
        : this.#options.plugins.status(action.pluginId) !== 'active' ? 'plugin-stopping' : null;
      if (rejection) {
        this.#emit('execution.dispatch.rejected', { id, code: rejection });
        receipt = { status: 'failed', reason: rejection, evidence: null };
      } else {
        try {
          receipt = this.#receipt(await this.#invoke(pending, 'execute', options.signal,
            signal => capability.execute({ ...context, signal })));
        } catch {
          // Timeouts, malformed replies and lost connections may hide an actual effect.
          receipt = { status: 'unknown', reason: 'Executor outcome unavailable; reconcile before any new action' };
        }
      }
      record = await this.#settle(record, receipt);
      return { kind: 'record', record, unchanged: false };
    } catch (error) {
      if (retained) throw error; // Journal failures must never masquerade as a safely rejected action.
      return rejected(error instanceof HubError ? error.code : 'preflight-failed',
        error instanceof Error ? error.message : 'Preflight failed');
    } finally {
      if (!retained) {
        const acquired = lease;
        if (preflight) void preflight.finally(() => acquired?.release()).catch(() => {});
        else acquired?.release();
      }
      this.#executingProposals.delete(proposalId);
      this.#executing.delete(id);
    }
  }

  #receipt(value: unknown): Receipt {
    assertReceipt(value);
    return immutable(value);
  }

  #releasePending(pending: Pending): void {
    if (!pending.terminal || pending.callbacks > 0) return;
    const id = pending.context.idempotencyKey;
    pending.lease.release();
    this.#pending.delete(id);
    this.#emit('execution.lease.released', { id });
  }
  /** The record reached a terminal state (here or elsewhere); drop this process's hold on it once callbacks settle. */
  #settleLocal(id: string): void {
    const pending = this.#pending.get(id);
    if (pending) { pending.terminal = true; this.#releasePending(pending); }
  }

  /**
   * Re-bind a record persisted by an earlier process to the active plugin of the exact same version.
   * Query-only: the lease serves reconcile/verify, never execute. Failing to bind leaves the record and its reservations untouched.
   */
  #adopt(record: ExecutionRecord): Pending {
    const { intent, observation, action, operationId } = record;
    const lease = this.#options.plugins.rebind(action.pluginId, action.pluginVersion, action.capability, intent.scope);
    // AbortSignal cannot be cloned; #invoke substitutes its own bounded signal for every callback.
    const context: ExecutionContext = Object.freeze({ intent, observation, action, operationId,
      idempotencyKey: record.id, signal: new AbortController().signal });
    const pending: Pending = { lease, context, callbacks: 0, terminal: false };
    this.#pending.set(record.id, pending);
    this.#emit('execution.recovered', { id: record.id, pluginId: action.pluginId, pluginVersion: action.pluginVersion });
    return pending;
  }

  /** A deadline ends waiting; each actual callback keeps the plugin alive until it settles. */
  async #invoke<T>(pending: Pending, phase: 'execute' | 'verify' | 'reconcile', signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const id = pending.context.idempotencyKey;
    try {
      return await bounded(this.#executionTimeout, signal, async callbackSignal => {
        pending.callbacks++;
        this.#emit('execution.callback.started', { id, phase, callbacks: pending.callbacks });
        try { return await operation(callbackSignal); }
        finally {
          pending.callbacks--;
          this.#emit('execution.callback.settled', { id, phase, callbacks: pending.callbacks,
            aborted: callbackSignal.aborted, terminal: pending.terminal });
          this.#releasePending(pending);
        }
      });
    } catch (error) {
      this.#emit('execution.callback.unavailable', { id, phase,
        code: error instanceof HubError ? error.code : 'callback-error' });
      throw error;
    }
  }

  async #replace(record: ExecutionRecord, patch: Patch): Promise<ExecutionRecord> {
    const next = immutable({ ...record, ...patch, revision: record.revision + 1, updatedAt: this.#now() });
    await this.journal.replace(next, record.revision);
    this.#emit('execution.updated', { id: next.id, status: next.status });
    if (terminal(next.status)) this.#settleLocal(next.id);
    return next;
  }
  /** Skip revisions that change nothing, so polling reconciliation never inflates the journal. */
  async #write(record: ExecutionRecord, patch: Patch): Promise<ExecutionRecord> {
    const next = { ...record, ...patch };
    const same = (['status', 'receipt', 'evidence'] as const).every(key => canonical(record[key]) === canonical(next[key]));
    return same ? record : this.#replace(record, patch);
  }
  /** Record the receipt, then confirm any open outcome against independent evidence. */
  async #settle(record: ExecutionRecord, receipt: Receipt,
    options: { verify?: boolean; signal?: AbortSignal } = {}): Promise<ExecutionRecord> {
    if (receipt.status === 'failed') return this.#write(record, { status: 'failed', receipt, evidence: receipt.evidence });
    const status = receipt.status === 'unknown' ? 'unknown' : 'pending';
    record = await this.#write(record, { status, receipt });
    // Dispatch verifies completed receipts right away; reconciliation verifies accepted and unknown ones too.
    if (!options.verify && receipt.status !== 'completed') return record;
    const pending = this.#pending.get(record.id)!;
    let verification: Verification;
    try {
      verification = await this.#invoke(pending, 'verify', options.signal, signal =>
        pending.lease.registration.capability.verify({ ...pending.context, signal }, receipt));
      assertJson(verification);
      ensure(['verified', 'pending', 'failed'].includes(verification.status), 'invalid-verification', 'Invalid verifier status');
      assertJson(verification.evidence);
    } catch { return record; } // Completed execution is not verified completion.
    // Inconclusive evidence changes nothing: an unknown outcome stays unknown.
    return this.#write(record, { status: verification.status === 'pending' ? status : verification.status, evidence: verification.evidence });
  }

  /**
   * Query and independently verify an open outcome. Never resubmits.
   * Records left open by an earlier process are re-bound to the same plugin version first; a journal is driven by one hub at a time.
   */
  async reconcile(id: string, options: { signal?: AbortSignal } = {}): Promise<ExecutionResult> {
    if (this.#executing.has(id)) return rejected('busy', 'Operation is already being handled');
    this.#executing.add(id);
    try {
      const stored = await this.journal.get(id);
      if (!stored) return rejected('unknown-operation', 'Unknown operation');
      assertRecord(stored);
      const record = immutable(stored);
      if (terminal(record.status)) { this.#settleLocal(id); return { kind: 'record', record, unchanged: true }; }
      let adopted = this.#pending.get(id);
      if (!adopted) {
        try { adopted = this.#adopt(record); }
        catch (error) {
          const code = error instanceof HubError ? error.code : 'unavailable-capability';
          this.#emit('execution.recovery.blocked', { id, code });
          return rejected(code, error instanceof Error ? error.message : 'Recovery binding failed');
        }
      }
      const pending = adopted;
      const capability = pending.lease.registration.capability;
      // A dispatched action whose receipt was never recorded is an unknown outcome, not a fresh one.
      let receipt: Receipt = record.receipt ?? { status: 'unknown', reason: 'No receipt was recorded' };
      if (capability.reconcile) {
        try {
          receipt = this.#receipt(await this.#invoke(pending, 'reconcile', options.signal,
            signal => capability.reconcile!({ ...pending.context, signal }, record.receipt)));
        } catch { return rejected('reconcile-failed', 'Outcome query failed; the record is unchanged'); }
      }
      try {
        const settled = await this.#settle(record, receipt, { ...options, verify: true });
        return { kind: 'record', record: settled, unchanged: settled.revision === record.revision };
      } catch (error) {
        if (!(error instanceof HubError && error.code === 'journal-conflict')) throw error;
        // Another hub advanced this record. Converge on its result; never fight over the journal.
        const current = await this.journal.get(id);
        if (current && terminal(current.status)) { this.#settleLocal(id); return { kind: 'record', record: current, unchanged: true }; }
        return rejected('journal-conflict', 'Another writer advanced this record; reconcile again');
      }
    } finally { this.#executing.delete(id); }
  }
}
