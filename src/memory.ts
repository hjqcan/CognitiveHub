import type {
  Claim, DeliberationProvider, DeliberationRequest, EventSink, ExecutionJournal, ExecutionRecord, HubEvent,
} from './contracts.js';
import { assertRecord, canonical, ensure, immutable } from './primitives.js';

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
