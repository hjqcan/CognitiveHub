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

/** What the host actually did at the moment of one recorded decision: one of the bound candidates, or nothing. */
export interface AdviceLabel {
  readonly decisionId: string;
  readonly actual: { readonly capability: string; readonly key: string } | null;
}
export interface AdviceComparison {
  /** Labels that matched a recorded decision. */
  readonly labelled: number;
  /** The advice was the host's action, or advised no action when the host did nothing. */
  readonly agreed: number;
  readonly agreement: number | null;
  /** Of the labels where the host acted, how often that action was among the bound candidates at all. */
  readonly recall: number | null;
  /** The host acted and the advice was a different action. */
  readonly differed: number;
  /** The host acted and the advice was to wait or ask, or there was nothing to decide. */
  readonly abstained: number;
  /** The host did nothing and the advice was to act. */
  readonly overreach: number;
  /** Decisions where the host's action was not a candidate: the capability adapters, not the decider, missed it. */
  readonly missing: readonly { readonly decisionId: string; readonly actual: { readonly capability: string; readonly key: string } }[];
  /** Label ids with no recorded decision. */
  readonly unmatched: readonly string[];
}
/**
 * Compare recorded advice with what the host actually did (phase A shadowing). Pure and read-only. Agreement measures the
 * decider on the candidates it was given; recall measures the capability adapters. Neither says an action would have
 * succeeded: advice that matches the host is not evidence of a verified effect.
 */
export function compareAdvice(records: readonly DecisionRecord[], labels: readonly AdviceLabel[]): AdviceComparison {
  const byId = new Map(records.map(r => [r.id, r]));
  const missing: { decisionId: string; actual: { capability: string; key: string } }[] = [];
  const unmatched: string[] = [];
  let labelled = 0, agreed = 0, acted = 0, recalled = 0, differed = 0, abstained = 0, overreach = 0;
  for (const label of labels) {
    const record = byId.get(label.decisionId);
    if (!record) { unmatched.push(label.decisionId); continue; }
    labelled++;
    const candidates = record.request?.candidates ?? [];
    const chosen = record.decision?.kind === 'action' ? candidates.find(c => c.id === (record.decision as { candidateId: string }).candidateId) : undefined;
    const actual = label.actual;
    if (actual === null) { if (chosen) overreach++; else agreed++; continue; }
    acted++;
    if (candidates.some(c => c.capability === actual.capability && c.key === actual.key)) recalled++;
    else missing.push({ decisionId: label.decisionId, actual });
    if (chosen && chosen.capability === actual.capability && chosen.key === actual.key) agreed++;
    else if (chosen) differed++;
    else abstained++;
  }
  return { labelled, agreed, agreement: labelled ? agreed / labelled : null, recall: acted ? recalled / acted : null,
    differed, abstained, overreach, missing, unmatched };
}
