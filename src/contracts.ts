/** Public contracts are model-, transport-, and robot-independent. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Scope = readonly string[];
export type MaybePromise<T> = T | Promise<T>;
export type Dispose = () => MaybePromise<void>;

export interface Intent {
  readonly id: string;
  readonly revision: number;
  /** First segment is the tenant; subsequent segments identify a robot/task. */
  readonly scope: Scope;
  readonly objective: string;
  readonly constraints: readonly string[];
  /** Requested capabilities, NOT authorization grants. Exact contract IDs only. */
  readonly capabilities: readonly string[];
}
export interface Observation {
  readonly version: string;
  readonly observedAt: number;
  readonly validUntil: number;
  /** Host-curated facts. Never put credentials or unrestricted raw data here. */
  readonly facts: Json;
}
export interface StateProvider {
  observe(intent: Intent, signal: AbortSignal): Promise<Observation>;
}
export interface CandidateDraft {
  readonly key: string;
  readonly description: string;
  readonly input: Json;
  /** Exclusive resource IDs within the tenant; canonicalized by the host. */
  readonly resources: readonly string[];
}
export interface BoundAction extends CandidateDraft {
  /** Identity of what would be done: plugin, capability and candidate key. Excludes the activation. */
  readonly id: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
  /** Process-local lease generation binding a proposal to one activation. Not part of action identity; meaningless in persisted records. */
  readonly activation: number;
  readonly capability: string;
  readonly effect: 'read' | 'write' | 'physical';
  readonly scope: Scope;
}
export interface PreparationContext {
  readonly intent: Intent;
  readonly observation: Observation;
  readonly signal: AbortSignal;
}
export interface ExecutionContext extends PreparationContext {
  readonly action: BoundAction;
  readonly operationId: string;
  /** Stable across retries. The executor must pass it to the actual task system. */
  readonly idempotencyKey: string;
  /** Exclusive latest dispatch time (epoch ms). Host gateways must enforce it before their own side effect. */
  readonly dispatchDeadlineAt?: number;
}
export type Receipt =
  | { readonly status: 'accepted'; readonly handle: string; readonly evidence: Json }
  | { readonly status: 'completed'; readonly evidence: Json }
  | { readonly status: 'failed'; readonly reason: string; readonly evidence: Json }
  | { readonly status: 'unknown'; readonly reason: string };
export type Verification =
  | { readonly status: 'verified'; readonly evidence: Json }
  | { readonly status: 'pending'; readonly evidence: Json }
  | { readonly status: 'failed'; readonly evidence: Json };

export interface Capability {
  /** Include semantic contract version, e.g. logistics.request-replan@1. */
  readonly id: string;
  readonly description: string;
  readonly effect: BoundAction['effect'];
  /** Must be side-effect free. Return fully bound, finite action candidates. */
  prepare(context: PreparationContext): Promise<readonly CandidateDraft[]>;
  /** Runtime schema/semantic validation, also called just before execution. */
  validate(input: Json): void;
  /** Revalidate local prerequisites; authoritative checks remain at the host. */
  check(context: ExecutionContext): Promise<boolean>;
  execute(context: ExecutionContext): Promise<Receipt>;
  /**
   * Query independent evidence. The receipt is only a hint: an accepted handle, or unknown when
   * nothing reliable was recorded. Return pending unless the evidence is conclusive.
   */
  verify(context: ExecutionContext, receipt: Receipt): Promise<Verification>;
  /**
   * Optional: recover a lost receipt (e.g. by idempotency key) without resubmitting. verify still confirms it.
   * The receipt is null when the process died between the journal claim and receipt persistence.
   */
  reconcile?(context: ExecutionContext, receipt: Receipt | null): Promise<Receipt>;
}
/** Versioned judgment criteria supplied by a human or slow thinker. Data for the decider; never authorization. */
export interface Guidance {
  readonly version: number;
  readonly criteria: readonly string[];
  /** Conditions under which the decider should ask rather than act. */
  readonly escalate: readonly string[];
  readonly author: string;
  readonly createdAt: number;
}
export interface DecisionRequest {
  readonly intent: Intent;
  readonly observation: Observation;
  readonly candidates: readonly BoundAction[];
  /** Present when the host or the managed runtime supplies judgment criteria. Cannot widen what Policy allows. */
  readonly guidance?: Guidance;
}
/**
 * `provider` names who actually decided when a DecisionProvider routes or wraps others (a router, a rule, a budget guard).
 * The decision record uses it instead of the configured provider's name.
 */
export type Decision =
  | { readonly kind: 'action'; readonly candidateId: string; readonly metadata?: Json; readonly provider?: string }
  | { readonly kind: 'wait'; readonly reason: string; readonly metadata?: Json; readonly provider?: string }
  | { readonly kind: 'deliberate'; readonly reason: string; readonly metadata?: Json; readonly provider?: string };
/** Where a propose() turn was when it ended: gathering state, binding candidates, applying policy, deciding, or creating the proposal. */
export type TurnPhase = 'observe' | 'prepare' | 'policy' | 'decide' | 'commit';
/**
 * Why a turn asked for deliberation. Carried as `DeliberationRequest.subject` with `kind: 'decision'`.
 * A type alias rather than an interface so that it is assignable to Json.
 */
export type DecisionSubject = {
  /** no-candidates: nothing authorized and applicable; decider-asked: the decider chose to ask; failed: the turn failed. */
  readonly cause: 'no-candidates' | 'decider-asked' | 'failed';
  readonly code: string | null;
  readonly phase: TurnPhase;
  readonly decisionId: string;
  /** Drafts prepared across all requested capabilities, before policy. */
  readonly considered: number;
  /** Action ids the policy allowed this turn. */
  readonly candidates: readonly string[];
  readonly excluded: readonly { readonly actionId: string; readonly reason: string }[];
};
export interface DecisionProvider {
  readonly name: string;
  decide(request: DecisionRequest, signal: AbortSignal): Promise<Decision>;
}
/** During propose, candidates is the whole bound set for this turn; during execute it is only the action. */
export interface PolicyRequest extends DecisionRequest {
  readonly action: BoundAction;
  readonly phase: 'propose' | 'execute';
}
export interface Policy {
  /** Must consult current host grants, intent revision, resource ownership, etc. */
  check(request: PolicyRequest, signal: AbortSignal): Promise<
    { readonly allowed: boolean; readonly version: string; readonly reason: string }
  >;
}
export interface DeliberationRequest {
  readonly id: string;
  readonly intent: Intent;
  readonly stateVersion: string | null;
  readonly reason: string;
  readonly createdAt: number;
  /** Set by the managed runtime: which run is blocked, why, and what a response must reference. */
  readonly runId?: string;
  readonly kind?: string;
  readonly subject?: Json;
}
export interface DeliberationProvider {
  /** At-least-once delivery: deduplicate by request.id. The host authenticates responses and reproposes against fresh state. */
  request(request: DeliberationRequest): Promise<void>;
}
/** `decisionId` names the turn (and its DecisionRecord when a store is configured); absent only when another turn was already in flight. */
export type ProposalResult =
  | { readonly kind: 'proposal'; readonly id: string; readonly action: BoundAction;
      readonly expiresAt: number; readonly decision: Decision; readonly stateVersion: string; readonly decisionId?: string }
  /** `code` is set when the wait comes from a failure path (for example `aborted`), like DecisionRecord.code. */
  | { readonly kind: 'wait'; readonly reason: string; readonly code?: string; readonly decisionId?: string }
  | { readonly kind: 'deliberation'; readonly request: DeliberationRequest; readonly decisionId?: string };
export type ExecutionStatus = 'submitted' | 'pending' | 'unknown' | 'verified' | 'failed';
export interface ExecutionRecord {
  readonly id: string;
  readonly revision: number;
  readonly operationId: string;
  readonly fingerprint: string;
  readonly intent: Intent;
  readonly observation: Observation;
  readonly action: BoundAction;
  readonly status: ExecutionStatus;
  readonly receipt: Receipt | null;
  readonly evidence: Json;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type Claim =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'existing'; readonly record: ExecutionRecord }
  | { readonly kind: 'conflict'; readonly reason: string };
export interface ExecutionJournal {
  /** Atomically reserve operation ID AND exclusive tenant resources. */
  claim(record: ExecutionRecord): Promise<Claim>;
  get(id: string): Promise<ExecutionRecord | undefined>;
  /** Compare-and-swap; MUST throw HubError('journal-conflict') on a revision mismatch. Terminal records release their reservations. */
  replace(record: ExecutionRecord, expectedRevision: number): Promise<void>;
  /** Non-terminal records, so a fresh process can reconcile what an earlier one left open. */
  unsettled(): Promise<readonly ExecutionRecord[]>;
}
export type ExecutionResult =
  /** unchanged: this call wrote nothing, because the operation was already recorded or nothing new was learned. */
  | { readonly kind: 'record'; readonly record: ExecutionRecord; readonly unchanged: boolean }
  | { readonly kind: 'dry-run'; readonly action: BoundAction }
  /** code is stable and machine-readable; reason is for humans and may change. */
  | { readonly kind: 'rejected'; readonly code: string; readonly reason: string };
/**
 * Why one turn went the way it did, from what propose() computed anyway. Observability and offline replay,
 * never authorization. The stored request contains observation facts: govern it like the journal.
 */
export interface DecisionRecord {
  readonly id: string;
  readonly intentId: string;
  readonly intentRevision: number;
  readonly scope: Scope;
  /** Opaque string labels supplied by the caller (the managed runtime sets runId). */
  readonly tags: { readonly [key: string]: string };
  readonly observationVersion: string | null;
  readonly guidanceVersion: number | null;
  /** Capabilities visible in scope that the intent did not request. */
  readonly notRequested: readonly string[];
  /** Capabilities whose prepare() ran, with how many drafts each produced. */
  readonly considered: readonly { readonly pluginId: string; readonly pluginVersion: string; readonly capability: string; readonly drafts: number }[];
  /** Bound actions the host policy denied. */
  readonly excluded: readonly { readonly actionId: string; readonly policyVersion: string; readonly reason: string }[];
  /** Exactly what the decider saw, or null when there was nothing to decide. */
  readonly request: DecisionRequest | null;
  readonly provider: string;
  readonly decision: Decision | null;
  readonly outcome: 'proposal' | 'wait' | 'deliberation';
  /** Error code when the turn ended through a failure path, else null. */
  readonly code: string | null;
  /** Where the turn ended. Absent in records written before v0.3. */
  readonly phase?: TurnPhase | null;
  readonly proposalId: string | null;
  readonly requestId: string | null;
  /** Journal record produced from the proposal; linked when execution claims it. */
  readonly recordId: string | null;
  readonly createdAt: number;
}
export interface DecisionStore {
  append(record: DecisionRecord): Promise<void>;
  link(id: string, recordId: string): Promise<void>;
  /** Optional: one record by id, for hosts that follow a StepResult's or ProposalResult's decisionId. */
  get?(id: string): Promise<DecisionRecord | undefined>;
  /** Ascending by createdAt; limit keeps the earliest matches. */
  list(query?: { readonly intentId?: string; readonly tag?: { readonly key: string; readonly value: string }; readonly limit?: number }):
    Promise<readonly DecisionRecord[]>;
}
export interface HubEvent {
  readonly type: string;
  readonly at: number;
  readonly data: Json;
}
export interface EventSink {
  /** Observational, not an authorization hook or a durable execution journal. */
  emit(event: HubEvent): void;
}
export interface CapabilityRegistration {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly activation: number;
  readonly scope: Scope;
  readonly capability: Capability;
}
export interface PluginManifest {
  readonly apiVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly requires?: readonly string[];
  readonly provides?: readonly string[];
}
export interface PluginContext {
  readonly scope: Scope;
  service<T>(key: string): T;
  provide<T>(key: string, value: T): void;
  capability(capability: Capability): void;
  onDispose(dispose: Dispose): void;
}
export interface Plugin {
  readonly manifest: PluginManifest;
  setup(context: PluginContext): MaybePromise<void | Dispose>;
}
