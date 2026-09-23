import type {
  Claim, DecisionRecord, DecisionStore, DeliberationProvider, DeliberationRequest, EventSink, ExecutionJournal, ExecutionRecord, HubEvent,
} from './contracts.js';
import type { Run, RunStore } from './run.js';
import { dueRuns, runTerminal } from './run.js';
import { assertJson, assertRecord, canonical, ensure, identifier, immutable } from './primitives.js';

export const terminal = (status: ExecutionRecord['status']): boolean => status === 'verified' || status === 'failed';
/**
 * Single-process reference adapter. No cross-process lock or exactly-once guarantee.
 * entries() exports plain JSON; the constructor rebuilds a journal from it, so a host can persist it however it likes.
 */
export class MemoryJournal implements ExecutionJournal {
  readonly #records = new Map<string, ExecutionRecord>();
  readonly #locks = new Map<string, string>();
  /** Terminal records are idempotency history and must be imported too; unsettled ones reclaim their resources. */
  constructor(records: readonly ExecutionRecord[] = []) {
    for (const input of records) {
      assertRecord(input);
      ensure(!this.#records.has(input.id), 'invalid-record', `Duplicate record ${input.id}`);
      const record = immutable(input);
      this.#records.set(record.id, record);
      if (terminal(record.status)) continue;
      for (const key of this.#resources(record)) {
        ensure(!this.#locks.has(key), 'journal-conflict', 'Two unsettled records reserve the same resource');
        this.#locks.set(key, record.id);
      }
    }
  }
  #resources(record: ExecutionRecord): string[] {
    return record.action.resources.map(r => canonical([record.intent.scope[0]!, r]));
  }
  async get(id: string): Promise<ExecutionRecord | undefined> { return this.#records.get(id); }
  async unsettled(): Promise<readonly ExecutionRecord[]> { return [...this.#records.values()].filter(r => !terminal(r.status)); }
  async claim(record: ExecutionRecord): Promise<Claim> {
    assertRecord(record);
    const existing = this.#records.get(record.id);
    if (existing) return existing.fingerprint === record.fingerprint
      ? { kind: 'existing', record: existing }
      : { kind: 'conflict', reason: 'Operation ID already belongs to a different action' };
    ensure(record.status === 'submitted' && record.revision === 0, 'invalid-record', 'Initial record must be submitted');
    const resources = this.#resources(record);
    if (resources.some(key => this.#locks.has(key))) return { kind: 'conflict', reason: 'A resource has an unresolved operation' };
    this.#records.set(record.id, immutable(record));
    resources.forEach(key => this.#locks.set(key, record.id));
    return { kind: 'claimed' };
  }
  async replace(record: ExecutionRecord, expectedRevision: number): Promise<void> {
    assertRecord(record);
    const current = this.#records.get(record.id);
    ensure(current && current.revision === expectedRevision && record.revision === expectedRevision + 1,
      'journal-conflict', 'Execution record version conflict');
    ensure(!terminal(current.status), 'terminal-record', 'A terminal result cannot be overwritten');
    ensure(current.fingerprint === record.fingerprint && canonical(current.action) === canonical(record.action) &&
      canonical(current.intent) === canonical(record.intent), 'invalid-record', 'Action identity is immutable');
    this.#records.set(record.id, immutable(record));
    if (terminal(record.status)) for (const key of this.#resources(record)) this.#locks.delete(key);
  }
  entries(): readonly ExecutionRecord[] { return [...this.#records.values()]; }
}
export class HumanInbox implements DeliberationProvider {
  readonly #requests = new Map<string, DeliberationRequest>();
  async request(request: DeliberationRequest): Promise<void> {
    this.#requests.set(request.id, immutable(request));
  }
  pending(): readonly DeliberationRequest[] { return [...this.#requests.values()]; }
  /** Acknowledge delivery/handling, NOT approval to execute an old proposal. */
  acknowledge(id: string): boolean { return this.#requests.delete(id); }
}
/** Single-process run store. entries()/events() export plain JSON; the constructor rebuilds from it. */
export class MemoryRunStore implements RunStore {
  readonly #runs = new Map<string, Run>();
  readonly #events = new Set<string>();
  constructor(runs: readonly Run[] = [], events: readonly string[] = []) {
    for (const input of runs) {
      assertJson(input); identifier(input.id, 'run id');
      ensure(!this.#runs.has(input.id), 'invalid-run', `Duplicate run ${input.id}`);
      this.#runs.set(input.id, immutable(input));
    }
    for (const key of events) {
      identifier(key, 'event key'); this.#events.add(key);
      const pair: unknown = JSON.parse(key);
      ensure(Array.isArray(pair) && pair.length === 2 && pair.every(x => typeof x === 'string'), 'invalid-event', 'Invalid exported event key');
      const run = this.#runs.get(pair[0] as string);
      if (run && !(run.processedEvents ?? []).includes(pair[1] as string))
        this.#runs.set(run.id, immutable({ ...run, processedEvents: [...(run.processedEvents ?? []), pair[1] as string] }));
    }
  }
  async create(run: Run): Promise<void> {
    ensure(!this.#runs.has(run.id), 'run-exists', `Run ${run.id} already exists`);
    ensure(run.revision === 0, 'invalid-run', 'A new run starts at revision 0');
    const key = canonical([run.intent.scope, run.intent.id]);
    ensure(![...this.#runs.values()].some(r => !runTerminal(r.status) && canonical([r.intent.scope, r.intent.id]) === key),
      'run-exists', 'An unsettled run already exists for this intent');
    this.#runs.set(run.id, immutable(run));
  }
  async get(id: string): Promise<Run | undefined> { return this.#runs.get(id); }
  async replace(run: Run, expectedRevision: number): Promise<void> {
    const current = this.#runs.get(run.id);
    ensure(current && current.revision === expectedRevision && run.revision === expectedRevision + 1, 'run-conflict', 'Run version conflict');
    ensure(!runTerminal(current.status), 'run-terminal', 'A finished run cannot be changed');
    this.#runs.set(run.id, immutable(run));
  }
  async markEvent(runId: string, key: string): Promise<boolean> {
    const seen = canonical([runId, key]);
    if (this.#events.has(seen)) return false;
    this.#events.add(seen);
    return true;
  }
  async unsettled(): Promise<readonly Run[]> { return [...this.#runs.values()].filter(r => !runTerminal(r.status)); }
  async due(now: number, limit?: number): Promise<readonly string[]> { return dueRuns([...this.#runs.values()], now, limit); }
  entries(): readonly Run[] { return [...this.#runs.values()]; }
  events(): readonly string[] { return [...this.#events]; }
}
/** Single-process decision audit. entries() exports plain JSON; the constructor rebuilds from it. */
export class MemoryDecisionStore implements DecisionStore {
  readonly #records = new Map<string, DecisionRecord>();
  constructor(records: readonly DecisionRecord[] = []) {
    for (const input of records) {
      assertJson(input as unknown); identifier(input.id, 'decision id');
      ensure(!this.#records.has(input.id), 'duplicate-decision', `Duplicate decision ${input.id}`);
      this.#records.set(input.id, immutable(input));
    }
  }
  async append(record: DecisionRecord): Promise<void> {
    assertJson(record as unknown); identifier(record.id, 'decision id');
    ensure(!this.#records.has(record.id), 'duplicate-decision', `Duplicate decision ${record.id}`);
    this.#records.set(record.id, immutable(record));
  }
  async link(id: string, recordId: string): Promise<void> {
    identifier(recordId, 'record id');
    const current = this.#records.get(id);
    ensure(current, 'unknown-decision', `Unknown decision ${id}`);
    this.#records.set(id, immutable({ ...current, recordId }));
  }
  async get(id: string): Promise<DecisionRecord | undefined> { return this.#records.get(id); }
  async list(query: { readonly intentId?: string; readonly tag?: { readonly key: string; readonly value: string }; readonly limit?: number } = {}):
    Promise<readonly DecisionRecord[]> {
    const rows = [...this.#records.values()]
      .filter(r => (query.intentId === undefined || r.intentId === query.intentId) &&
        (query.tag === undefined || r.tags[query.tag.key] === query.tag.value))
      .sort((a, b) => a.createdAt - b.createdAt);
    return query.limit === undefined ? rows : rows.slice(0, query.limit);
  }
  entries(): readonly DecisionRecord[] { return [...this.#records.values()]; }
}
export class MemoryEvents implements EventSink {
  readonly #events: HubEvent[] = [];
  constructor(readonly capacity = 1000) {
    ensure(Number.isInteger(capacity) && capacity > 0, 'invalid-capacity', 'Event capacity must be positive');
  }
  emit(event: HubEvent): void {
    this.#events.push(immutable(event));
    if (this.#events.length > this.capacity) this.#events.shift();
  }
  entries(): readonly HubEvent[] { return [...this.#events]; }
}
