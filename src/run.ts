import type { DecisionErrorMode, DeliberationRequest, ExecutionRecord, Guidance, Intent, Json, Observation } from './contracts.js';

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
/**
 * What a step does when no capability offers a candidate. `deliberate` (default) asks the host, which is right when
 * an empty set means a missing plugin or authorization. `wait` registers a state + time wait instead, for runs that
 * legitimately have nothing to do until the world changes (a reviewer with an empty queue, a market maker before the open).
 */
export type IdleMode = 'deliberate' | 'wait';
export interface RunSpec {
  readonly intent: Intent;
  readonly budget: Budget;
  /** Required, no default: each-action asks the host before every dispatch. */
  readonly approval: ApprovalMode;
  readonly guidance?: Guidance;
  readonly waitMs?: number;
  readonly idle?: IdleMode;
  /**
   * `wait` turns a failed decide phase into a timed wait that counts toward `maxNoProgress`, so a decider that stays down
   * still reaches the host, as a no-progress request. Default `deliberate`: every decider failure asks the host.
   */
  readonly onDecisionError?: DecisionErrorMode;
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
  /** Runs persisted before this field existed read as `deliberate`. */
  readonly idle: IdleMode;
  /** Absent in runs persisted before v0.3, which read as `deliberate`. */
  readonly onDecisionError?: DecisionErrorMode;
  readonly status: RunStatus;
  /** Sticky host intent, independent of waiting/recovery status. Absent in legacy v0.2 snapshots. */
  readonly stopRequested?: boolean;
  /** Event consumption and the resulting state change are committed in the same Run CAS. */
  readonly processedEvents?: readonly string[];
  /** Single outstanding notification, atomically persisted with request/status before external delivery. */
  readonly outbox?: { readonly message: DeliberationRequest; readonly delivered: boolean; readonly retryAt: number } | null;
  /** Journal record ids of every operation this run dispatched, in order. Open ones are found in the journal, not here. */
  readonly operations: readonly string[];
  /**
   * How many leading entries of `operations` a successful goal evaluation has already seen terminal.
   * A runtime-owned cache: terminal records never change, so it only grows. Absent before v0.3 (reads as 0).
   * A host that rewrites `operations` must delete it.
   */
  readonly settled?: number;
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
  /**
   * `records`: this run's operations that no earlier successful evaluation saw terminal, as reconciled by this step,
   * in dispatch order. Usually only the latest one. Every operation is passed at least once after it becomes terminal,
   * unless the run stops first. `operations` lists every record id; an evaluator that needs history reads the journal.
   */
  evaluate(input: { readonly intent: Intent; readonly observation: Observation; readonly records: readonly ExecutionRecord[];
    readonly operations: readonly string[] }, signal: AbortSignal): Promise<GoalEvaluation>;
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
  /** Optional: ids of runs whose `runWakeAt` is at or before `now`, earliest first (ties by id). Without it the runtime filters `unsettled()`. */
  due?(now: number, limit?: number): Promise<readonly string[]>;
}
/**
 * The latest time the host should step a run: its last update while active or stopping, the retry time of an undelivered
 * notification, or the earliest time bound while waiting. Null when only an external answer or event can move it.
 */
export const runWakeAt = (run: Run): number | null => {
  if (run.status === 'active' || run.status === 'stopping') return run.updatedAt;
  if (run.status === 'deliberating' && run.outbox && !run.outbox.delivered) return run.outbox.retryAt;
  if (run.status !== 'waiting') return null;
  const times = run.wait.flatMap(c => c.kind === 'time' ? [c.at] : []);
  return times.length ? Math.min(...times) : null;
};
/** Reference ordering for `RunStore.due`, shared by the memory store and the runtime's fallback. */
export function dueRuns(runs: readonly Run[], now: number, limit?: number): readonly string[] {
  const rows = runs.flatMap(run => { const at = runWakeAt(run); return at !== null && at <= now ? [{ id: run.id, at }] : []; })
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return (limit === undefined ? rows : rows.slice(0, limit)).map(row => row.id);
}
export type StepOutcome = 'idle' | 'lease-held' | 'waiting' | 'executed' | 'rejected' | 'deliberating' | 'completed' | 'failed' | 'stopped';
export interface StepResult {
  readonly run: Run;
  readonly outcome: StepOutcome;
  /** The decision turn this step ran, if it reached propose(). Look it up in the DecisionStore. */
  readonly decisionId?: string;
  /** The journal record this step dispatched, or the one whose recovery blocked it. */
  readonly recordId?: string;
  /** Machine-readable reason when the step ended through a failure or rejection path. */
  readonly code?: string;
}
export type RunResult =
  | { readonly kind: 'applied'; readonly run: Run }
  | { readonly kind: 'rejected'; readonly code: string; readonly reason: string };
