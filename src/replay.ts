import type { Decision, DecisionProvider, DecisionRecord, DecisionStore, ExecutionJournal, Json } from './contracts.js';
import type { RunStore } from './run.js';
import { runTerminal } from './run.js';
import { assertJson, bounded, HubError, immutable } from './primitives.js';

/**
 * Read-only replay over recorded decisions, execution records and runs.
 * Nothing here constructs a hub or dispatches an action; re-evaluation only asks a decider what it would have chosen.
 */
export interface TimelineEntry {
  readonly at: number;
  readonly kind: 'run.started' | 'decision' | 'execution' | 'answer' | 'run.ended';
  readonly id: string;
  readonly summary: string;
  readonly detail: Json;
}
const RANK: Record<TimelineEntry['kind'], number> = { 'run.started': 0, decision: 1, execution: 2, answer: 3, 'run.ended': 4 };
const chosen = (record: DecisionRecord): string =>
  record.decision === null ? (record.code ?? 'nothing to decide')
    : record.decision.kind === 'action' ? record.decision.candidateId : record.decision.kind;

export async function timeline(
  stores: { readonly decisions: DecisionStore; readonly journal: ExecutionJournal; readonly runs?: RunStore },
  query: { readonly intentId?: string; readonly runId?: string; readonly limit?: number } = {},
): Promise<readonly TimelineEntry[]> {
  const entries: TimelineEntry[] = [];
  const records = await stores.decisions.list({
    ...(query.intentId !== undefined ? { intentId: query.intentId } : {}),
    ...(query.runId !== undefined ? { tag: { key: 'runId', value: query.runId } } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
  });
  for (const d of records) {
    const candidates = d.request?.candidates.map(c => c.id) ?? [];
    entries.push({ at: d.createdAt, kind: 'decision', id: d.id,
      summary: `${d.outcome} by ${d.provider}: ${chosen(d)}; ${candidates.length} candidates, ${d.excluded.length} excluded by policy` +
        (d.code ? `; code ${d.code}` : ''),
      detail: { intentId: d.intentId, intentRevision: d.intentRevision, tags: d.tags, observationVersion: d.observationVersion,
        guidanceVersion: d.guidanceVersion, notRequested: d.notRequested, considered: d.considered, excluded: d.excluded, candidates,
        decision: d.decision, code: d.code, phase: d.phase ?? null, provider: d.provider,
        proposalId: d.proposalId, requestId: d.requestId, recordId: d.recordId } });
    if (d.recordId === null) continue;
    const r = await stores.journal.get(d.recordId);
    if (!r) continue;
    entries.push({ at: r.createdAt, kind: 'execution', id: r.id,
      summary: `${r.action.capability} ${r.status}${r.receipt ? ` (receipt ${r.receipt.status})` : ''}`,
      detail: { operationId: r.operationId, status: r.status, receipt: r.receipt, evidence: r.evidence, settledAt: r.updatedAt } });
  }
  if (query.runId !== undefined && stores.runs) {
    const run = await stores.runs.get(query.runId);
    if (run) {
      entries.push({ at: run.createdAt, kind: 'run.started', id: run.id, summary: `started: ${run.intent.objective}`,
        detail: { intentId: run.intent.id, intentRevision: run.intent.revision, budget: { ...run.budget }, approval: run.approval } });
      for (const a of run.answers) entries.push({ at: a.at, kind: 'answer', id: a.requestId, summary: `${a.kind} response`, detail: a });
      if (runTerminal(run.status)) entries.push({ at: run.updatedAt, kind: 'run.ended', id: run.id,
        summary: `${run.status}: ${run.outcome?.reason ?? ''}`, detail: { status: run.status, outcome: run.outcome, counters: run.counters } });
    }
  }
  return entries.sort((a, b) => a.at - b.at || RANK[a.kind] - RANK[b.kind]);
}

export interface Reevaluation {
  readonly decisionId: string;
  readonly recorded: Decision | null;
  readonly replayed: Decision | null;
  readonly code: string | null;
  readonly agrees: boolean;
}
/** Ask a decider what it would choose for each recorded request. Compares choices; never executes anything. */
export async function reevaluate(records: readonly DecisionRecord[], provider: DecisionProvider,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}): Promise<readonly Reevaluation[]> {
  const results: Reevaluation[] = [];
  for (const record of records) {
    const request = record.request;
    if (request === null) continue;
    let replayed: Decision | null = null;
    let code: string | null = null;
    try {
      const decision = await bounded(options.timeoutMs ?? 5000, options.signal, s => provider.decide(request, s));
      assertJson(decision as unknown);
      replayed = immutable(decision);
    } catch (error) { code = error instanceof HubError ? error.code : 'decision-unavailable'; }
    const recorded = record.decision;
    const agrees = replayed !== null && recorded !== null && replayed.kind === recorded.kind &&
      (replayed.kind !== 'action' || recorded.kind !== 'action' || replayed.candidateId === recorded.candidateId);
    results.push({ decisionId: record.id, recorded, replayed, code, agrees });
  }
  return results;
}
