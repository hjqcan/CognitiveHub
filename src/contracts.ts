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
  readonly id: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
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
  verify(context: ExecutionContext, receipt: Receipt): Promise<Verification>;
  /** Read/query only. Never resubmit an unknown action here. */
  reconcile?(context: ExecutionContext, receipt: Receipt | null): Promise<Receipt>;
}
export interface DecisionRequest {
  readonly intent: Intent;
  readonly observation: Observation;
  readonly candidates: readonly BoundAction[];
}
export type Decision =
  | { readonly kind: 'action'; readonly candidateId: string; readonly metadata?: Json }
  | { readonly kind: 'wait'; readonly reason: string; readonly metadata?: Json }
  | { readonly kind: 'deliberate'; readonly reason: string; readonly metadata?: Json };
export interface DecisionProvider {
  readonly name: string;
  decide(request: DecisionRequest, signal: AbortSignal): Promise<Decision>;
}
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
}
export interface DeliberationProvider {
  /** The host authenticates responses and reproposes against fresh state. */
  request(request: DeliberationRequest): Promise<void>;
}
export type ProposalResult =
  | { readonly kind: 'proposal'; readonly id: string; readonly action: BoundAction;
      readonly expiresAt: number; readonly decision: Decision }
  | { readonly kind: 'wait'; readonly reason: string }
  | { readonly kind: 'deliberation'; readonly request: DeliberationRequest };
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
}
export type Claim =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'existing'; readonly record: ExecutionRecord }
  | { readonly kind: 'conflict'; readonly reason: string };
export interface ExecutionJournal {
  /** Atomically reserve operation ID AND exclusive tenant resources. */
  claim(record: ExecutionRecord): Promise<Claim>;
  get(id: string): Promise<ExecutionRecord | undefined>;
  /** Compare-and-swap. Terminal records release their resource reservations. */
  replace(record: ExecutionRecord, expectedRevision: number): Promise<void>;
}
export type ExecutionResult =
  | { readonly kind: 'record'; readonly record: ExecutionRecord; readonly duplicate: boolean }
  | { readonly kind: 'dry-run'; readonly action: BoundAction }
  | { readonly kind: 'rejected'; readonly reason: string };
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
