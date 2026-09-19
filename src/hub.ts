import type {
  BoundAction, Decision, DecisionProvider, DecisionRequest, DeliberationProvider,
  EventSink, ExecutionContext, ExecutionJournal, ExecutionRecord, ExecutionResult,
  Intent, Json, Observation, Policy, ProposalResult, Receipt, StateProvider, Verification,
} from './contracts.js';
import { PluginHost, type CapabilityLease } from './plugins.js';
import { MemoryJournal, terminal } from './memory.js';
import { assertJson, bounded, canonical, ensure, identifier, immutable, newId, validScope } from './primitives.js';

interface Proposal {
  id: string;
  intent: Intent;
  observation: Observation;
  action: BoundAction;
  decision: Decision;
  policyVersion: string;
  expiresAt: number;
}
interface Pending { lease: CapabilityLease; context: ExecutionContext }
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

  async propose(input: Intent, options: { signal?: AbortSignal } = {}): Promise<ProposalResult> {
    const intent = this.#intent(input);
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
          const candidates: BoundAction[] = [];
          const policyVersions = new Map<string, string>();
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
              const action: BoundAction = immutable({ ...draft,
                id: canonical([registration.pluginId, registration.activation, capability.id, draft.key]),
                pluginId: registration.pluginId, pluginVersion: registration.pluginVersion,
                activation: registration.activation, capability: capability.id,
                effect: capability.effect, scope: intent.scope,
              });
              const policy = await this.#options.policy.check({ intent, observation,
                candidates: [action], action, phase: 'propose' }, signal);
              signal.throwIfAborted(); identifier(policy.version, 'policy version');
              if (policy.allowed !== true) continue;
              candidates.push(action); policyVersions.set(action.id, policy.version);
              ensure(candidates.length <= this.#maxCandidates, 'candidate-limit', 'Too many candidates; narrow the capability adapters');
            }
          }
          if (!candidates.length) return { kind: 'deliberate' as const, reason: 'No authorized, applicable capability candidates' };
          const request: DecisionRequest = immutable({ intent, observation, candidates });
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
          return { kind: 'proposal' as const, id: proposal.id, action, expiresAt: proposal.expiresAt, decision };
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
    if (!proposal) return { kind: 'rejected', reason: 'Unknown or discarded proposal' };
    const { intent, action } = proposal;
    const id = canonical([intent.scope, intent.id, operationId]);
    const fingerprint = canonical({ intent, action });
    if (this.#executingProposals.has(proposalId)) return { kind: 'rejected', reason: 'Proposal is already being handled' };
    if (this.#consumed.has(proposalId) && this.#consumed.get(proposalId) !== id)
      return { kind: 'rejected', reason: 'Proposal already belongs to another operation' };
    if (this.#executing.has(id)) return { kind: 'rejected', reason: 'Operation is already being handled' };
    this.#executing.add(id);
    this.#executingProposals.add(proposalId);
    let preflight: Promise<ExecutionContext> | undefined;
    let lease: CapabilityLease | undefined;
    let retained = false;
    try {
      const existing = await this.journal.get(id);
      if (existing) return existing.fingerprint === fingerprint
        ? { kind: 'record', record: existing, duplicate: true }
        : { kind: 'rejected', reason: 'Operation ID already belongs to another action' };
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
      let record: ExecutionRecord = immutable({ id, revision: 0, operationId, fingerprint, intent,
        observation: context.observation, action, status: 'submitted', receipt: null, evidence: null });
      const claim = await this.journal.claim(record);
      if (claim.kind === 'existing') return { kind: 'record', record: claim.record, duplicate: true };
      if (claim.kind === 'conflict') return { kind: 'rejected', reason: claim.reason };
      // Retain the plugin and resources until a terminal result is durably recorded.
      retained = true;
      this.#consumed.set(proposalId, id);
      this.#pending.set(id, { lease, context });
      this.#emit('execution.submitted', { id, operationId, capability: action.capability });
      let receipt: Receipt;
      if (options.signal?.aborted || proposal.expiresAt <= this.#now() || this.#options.plugins.status(action.pluginId) !== 'active') {
        receipt = { status: 'failed', reason: 'Cancelled/expired before dispatch', evidence: null };
      } else {
        try {
          receipt = this.#receipt(await bounded(this.#executionTimeout, options.signal,
            signal => capability.execute({ ...context, signal })));
        } catch {
          // Timeouts, malformed replies and lost connections may hide an actual effect.
          receipt = { status: 'unknown', reason: 'Executor outcome unavailable; reconcile before any new action' };
        }
      }
      record = await this.#settle(record, receipt);
      return { kind: 'record', record, duplicate: false };
    } catch (error) {
      if (retained) throw error; // Journal failures must never masquerade as a safely rejected action.
      return { kind: 'rejected', reason: error instanceof Error ? error.message : 'Preflight failed' };
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

  #receipt(value: Receipt): Receipt {
    assertJson(value);
    ensure(['accepted', 'completed', 'failed', 'unknown'].includes(value.status), 'invalid-receipt', 'Unknown receipt status');
    if (value.status === 'accepted') identifier(value.handle, 'task handle');
    if (value.status === 'failed' || value.status === 'unknown') identifier(value.reason, 'receipt reason');
    if (value.status !== 'unknown') assertJson(value.evidence);
    return immutable(value);
  }
  async #replace(record: ExecutionRecord, patch: Partial<Pick<ExecutionRecord, 'status' | 'receipt' | 'evidence'>>): Promise<ExecutionRecord> {
    const next = immutable({ ...record, ...patch, revision: record.revision + 1 });
    await this.journal.replace(next, record.revision);
    this.#emit('execution.updated', { id: next.id, status: next.status });
    if (terminal(next.status)) {
      this.#pending.get(next.id)?.lease.release();
      this.#pending.delete(next.id);
    }
    return next;
  }
  async #settle(record: ExecutionRecord, receipt: Receipt): Promise<ExecutionRecord> {
    if (receipt.status === 'unknown') return this.#replace(record, { status: 'unknown', receipt });
    if (receipt.status === 'failed') return this.#replace(record, { status: 'failed', receipt, evidence: receipt.evidence });
    record = await this.#replace(record, { status: 'pending', receipt });
    if (receipt.status === 'accepted') return record;
    const pending = this.#pending.get(record.id)!;
    let verification: Verification;
    try {
      verification = await bounded(this.#executionTimeout, undefined, signal =>
        pending.lease.registration.capability.verify({ ...pending.context, signal }, receipt));
      assertJson(verification);
      ensure(['verified', 'pending', 'failed'].includes(verification.status), 'invalid-verification', 'Invalid verifier status');
      assertJson(verification.evidence);
    } catch { return record; } // Completed execution is not verified completion.
    return this.#replace(record, { status: verification.status, evidence: verification.evidence });
  }

  async reconcile(id: string, options: { signal?: AbortSignal } = {}): Promise<ExecutionResult> {
    if (this.#executing.has(id)) return { kind: 'rejected', reason: 'Operation is already being handled' };
    this.#executing.add(id);
    try {
      const record = await this.journal.get(id);
      if (!record) return { kind: 'rejected', reason: 'Unknown operation' };
      if (terminal(record.status)) return { kind: 'record', record, duplicate: true };
      const pending = this.#pending.get(id);
      if (!pending) return { kind: 'rejected', reason: 'Recovery requires the original runtime; persistent recovery is not implemented' };
      const capability = pending.lease.registration.capability;
      let receipt = record.receipt;
      if (capability.reconcile) {
        try {
          receipt = this.#receipt(await bounded(this.#executionTimeout, options.signal,
            signal => capability.reconcile!({ ...pending.context, signal }, record.receipt)));
        } catch { return { kind: 'record', record, duplicate: true }; }
      }
      if (!receipt) return { kind: 'record', record, duplicate: true };
      return { kind: 'record', record: await this.#settle(record, receipt), duplicate: false };
    } finally { this.#executing.delete(id); }
  }
}
