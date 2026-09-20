import type { DeliberationRequest, ExecutionRecord, Guidance, Intent, Json, Observation } from './contracts.js';

/**
 * Persisted run states. Observing, deciding and executing are phases inside one step(), not states:
 * the execution journal is the only truth about what was dispatched, so the run never records a second copy.
 */
export type RunStatus = 'active' | 'waiting' | 'deliberating' | 'paused' | 'stopping' | 'completed' | 'failed' | 'stopped';
export const runTerminal = (status: RunStatus): boolean => status === 'completed' || status === 'failed' || status === 'stopped';
export type RequestKind = 'decision' | 'approval' | 'budget' | 'no-progress' | 'recovery';
/** Any condition holding wakes a waiting run. The runtime always adds a time bound, so waits are never open-ended. */
export type WaitCondition =
  | { readonly kind: 'execution'; readonly recordId: string }
  | { readonly kind: 'deliberation'; readonly requestId: string }
  | { readonly kind: 'state'; readonly version: string }
  | { readonly kind: 'time'; readonly at: number };
export interface Budget {
  readonly maxDecisions: number;
  readonly maxActions: number;
  /** Consecutive decisions on the same state that chose the same thing, or timed wake-ups with no change. */
  readonly maxNoProgress: number;
  readonly deadlineAt: number | null;
}
export type ApprovalMode = 'automatic' | 'each-action';
export interface RunSpec {
  readonly intent: Intent;
  readonly budget: Budget;
  /** Required, no default: each-action asks the host before every dispatch. */
  readonly approval: ApprovalMode;
  readonly guidance?: Guidance;
  readonly waitMs?: number;
}
export interface Run {
  readonly id: string;
  /** Compare-and-swap version for the run store. */
  readonly revision: number;
  readonly intent: Intent;
  readonly guidance: Guidance | null;
  readonly budget: Budget;
  readonly approval: ApprovalMode;
  readonly waitMs: number;
  readonly status: RunStatus;
  /** Sticky host intent, independent of waiting/recovery status. Absent in legacy v0.2 snapshots. */
  readonly stopRequested?: boolean;
  /** Event consumption and the resulting state change are committed in the same Run CAS. */
  readonly processedEvents?: readonly string[];
  /** Single outstanding notification, atomically persisted with request/status before external delivery. */
  readonly outbox?: { readonly message: DeliberationRequest; readonly delivered: boolean; readonly retryAt: number } | null;
  /** Journal record ids of every operation this run dispatched, in order. Open ones are found in the journal, not here. */
  readonly operations: readonly string[];
  readonly wait: readonly WaitCondition[];
  readonly request: { readonly id: string; readonly kind: RequestKind; readonly subject: Json } | null;
  readonly approved: { readonly digest: string; readonly stateVersion: string; readonly expiresAt: number } | null;
  readonly answers: readonly { readonly requestId: string; readonly kind: string; readonly at: number }[];
  readonly counters: { readonly decisions: number; readonly actions: number; readonly noProgress: number; readonly signature: string | null };
  readonly progress: Json;
  readonly outcome: { readonly code: string; readonly reason: string; readonly evidence: Json } | null;
  readonly lease: { readonly owner: string; readonly expiresAt: number } | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
/**
 * The four things a human or slow thinker can say back. They are not interchangeable: a fact does not approve,
 * guidance does not widen authorization, an approval names one action at one state version.
 */
export type DeliberationResponse =
  | { readonly kind: 'fact'; readonly requestId: string; readonly intentRevision: number; readonly note: Json }
  | { readonly kind: 'guidance'; readonly requestId: string; readonly intentRevision: number; readonly guidance: Guidance }
  | { readonly kind: 'approve'; readonly requestId: string; readonly intentRevision: number;
      readonly digest: string; readonly stateVersion: string; readonly expiresAt: number }
  | { readonly kind: 'terminate'; readonly requestId: string; readonly intentRevision: number; readonly reason: string };
export interface GoalEvaluation {
  readonly status: 'satisfied' | 'unsatisfied' | 'unreachable';
  /** Host-queried evidence. A decider's output never reaches this port. */
  readonly evidence: Json;
  readonly progress?: Json;
}
export interface GoalEvaluator {
  evaluate(input: { readonly intent: Intent; readonly observation: Observation; readonly records: readonly ExecutionRecord[] },
    signal: AbortSignal): Promise<GoalEvaluation>;
}
export interface RunEvent {
  /** Deduplication key chosen by the host; a repeated key is ignored. */
  readonly key: string;
  readonly type: 'state-changed' | 'execution-updated' | 'timer' | 'host';
  readonly data: Json;
}
export interface RunStore {
  /** Rejects a duplicate id and a second unsettled run for the same intent identity. */
  create(run: Run): Promise<void>;
  get(id: string): Promise<Run | undefined>;
  /** Compare-and-swap; MUST throw HubError('run-conflict') on a revision mismatch. */
  replace(run: Run, expectedRevision: number): Promise<void>;
  /** Legacy standalone deduplication API. IntentRuntime uses Run.processedEvents plus one CAS instead. */
  markEvent(runId: string, key: string): Promise<boolean>;
  unsettled(): Promise<readonly Run[]>;
}
export type StepOutcome = 'idle' | 'lease-held' | 'waiting' | 'executed' | 'rejected' | 'deliberating' | 'completed' | 'failed' | 'stopped';
export interface StepResult { readonly run: Run; readonly outcome: StepOutcome }
export type RunResult =
  | { readonly kind: 'applied'; readonly run: Run }
  | { readonly kind: 'rejected'; readonly code: string; readonly reason: string };
