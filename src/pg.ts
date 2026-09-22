import type { Claim, DecisionRecord, DecisionStore, ExecutionJournal, ExecutionRecord } from './contracts.js';
import type { Run, RunStore } from './run.js';
import { runTerminal } from './run.js';
import { terminal } from './memory.js';
import { assertJson, assertRecord, ensure, HubError, identifier, immutable } from './primitives.js';

/**
 * PostgreSQL adapters for the execution journal and the run store.
 * They take any client with query(text, values) → { rows }: a node-postgres Pool or Client, PGlite, or a thin wrapper.
 * Every operation is one SQL statement, so atomicity comes from PostgreSQL itself and no transaction API is needed.
 * The core keeps zero runtime dependencies: nothing here imports a driver; the host owns credentials and pooling.
 */
export interface SqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export const SCHEMA_VERSION = 3;
/** Idempotent DDL in version order; each version ends by recording itself. Tables are prefixed; use search_path for further isolation. */
export const schema: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cognitive_hub_schema (version integer PRIMARY KEY, applied_at double precision NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cognitive_hub_records (
     id text PRIMARY KEY, tenant text NOT NULL, revision integer NOT NULL, status text NOT NULL,
     fingerprint text NOT NULL, data jsonb NOT NULL, updated_at double precision NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS cognitive_hub_records_unsettled ON cognitive_hub_records (tenant, updated_at)
     WHERE status NOT IN ('verified', 'failed')`,
  `CREATE TABLE IF NOT EXISTS cognitive_hub_locks (
     tenant text NOT NULL, resource text NOT NULL, record_id text NOT NULL REFERENCES cognitive_hub_records (id),
     PRIMARY KEY (tenant, resource))`,
  `CREATE TABLE IF NOT EXISTS cognitive_hub_runs (
     id text PRIMARY KEY, tenant text NOT NULL, intent_id text NOT NULL, revision integer NOT NULL, status text NOT NULL,
     wake_at double precision, data jsonb NOT NULL, updated_at double precision NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cognitive_hub_runs_one_unsettled_per_scope_intent
     ON cognitive_hub_runs ((data #> '{intent,scope}'), intent_id)
     WHERE status NOT IN ('completed', 'failed', 'stopped')`,
  `CREATE INDEX IF NOT EXISTS cognitive_hub_runs_due ON cognitive_hub_runs (wake_at) WHERE wake_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS cognitive_hub_run_events (run_id text NOT NULL, key text NOT NULL, PRIMARY KEY (run_id, key))`,
  `INSERT INTO cognitive_hub_schema (version, applied_at) VALUES (1, extract(epoch from now()) * 1000)
     ON CONFLICT (version) DO NOTHING`,
  // Version 2: decision audit.
  `CREATE TABLE IF NOT EXISTS cognitive_hub_decisions (
     id text PRIMARY KEY, tenant text NOT NULL, intent_id text NOT NULL, created_at double precision NOT NULL, data jsonb NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS cognitive_hub_decisions_by_intent ON cognitive_hub_decisions (tenant, intent_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS cognitive_hub_decisions_tags ON cognitive_hub_decisions USING gin ((data -> 'tags'))`,
  `INSERT INTO cognitive_hub_schema (version, applied_at) VALUES (2, extract(epoch from now()) * 1000)
     ON CONFLICT (version) DO NOTHING`,
  // v3: install the scoped replacement before dropping the v1 index; preserve legacy event receipts.
  `DROP INDEX IF EXISTS cognitive_hub_runs_one_unsettled_per_intent`,
  `UPDATE cognitive_hub_runs r SET data = jsonb_set(r.data, '{processedEvents}',
     COALESCE((SELECT jsonb_agg(e.key ORDER BY e.key) FROM cognitive_hub_run_events e WHERE e.run_id = r.id), '[]'::jsonb))
     WHERE NOT (r.data ? 'processedEvents')`,
  `INSERT INTO cognitive_hub_schema (version, applied_at) VALUES (3, extract(epoch from now()) * 1000)
     ON CONFLICT (version) DO NOTHING`,
];
export async function migrate(client: SqlClient): Promise<void> {
  for (const statement of schema) await client.query(statement);
}

const SQL = {
  // The record and its locks land together or not at all: a lock collision aborts the whole statement.
  claim: `WITH ins AS (
      INSERT INTO cognitive_hub_records (id, tenant, revision, status, fingerprint, data, updated_at)
      VALUES ($1, $2, 0, $3, $4, $5::jsonb, $6) ON CONFLICT (id) DO NOTHING RETURNING id),
    locks AS (
      INSERT INTO cognitive_hub_locks (tenant, resource, record_id)
      SELECT $2, value, ins.id FROM ins, jsonb_array_elements_text($7::jsonb) RETURNING resource)
    SELECT (SELECT count(*)::int FROM ins) AS inserted`,
  // Compare-and-swap on revision and identity; a terminal result releases the reservations in the same statement.
  replace: `WITH upd AS (
      UPDATE cognitive_hub_records SET revision = $2, status = $3, data = $4::jsonb, updated_at = $5
      WHERE id = $1 AND revision = $6 AND fingerprint = $7 AND status NOT IN ('verified', 'failed')
      RETURNING id, status),
    released AS (
      DELETE FROM cognitive_hub_locks WHERE record_id IN (SELECT id FROM upd WHERE status IN ('verified', 'failed'))
      RETURNING resource)
    SELECT (SELECT count(*)::int FROM upd) AS updated`,
  record: `SELECT data FROM cognitive_hub_records WHERE id = $1`,
  unsettledRecords: `SELECT data FROM cognitive_hub_records WHERE status NOT IN ('verified', 'failed') ORDER BY updated_at, id`,
  createRun: `INSERT INTO cognitive_hub_runs (id, tenant, intent_id, revision, status, wake_at, data, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) ON CONFLICT (id) DO NOTHING RETURNING id`,
  replaceRun: `UPDATE cognitive_hub_runs SET revision = $2, status = $3, wake_at = $4, data = $5::jsonb, updated_at = $6
    WHERE id = $1 AND revision = $7 AND status NOT IN ('completed', 'failed', 'stopped') RETURNING id`,
  run: `SELECT data FROM cognitive_hub_runs WHERE id = $1`,
  unsettledRuns: `SELECT data FROM cognitive_hub_runs WHERE status NOT IN ('completed', 'failed', 'stopped') ORDER BY updated_at, id`,
  markEvent: `INSERT INTO cognitive_hub_run_events (run_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING run_id`,
  appendDecision: `INSERT INTO cognitive_hub_decisions (id, tenant, intent_id, created_at, data)
    VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`,
  linkDecision: `UPDATE cognitive_hub_decisions SET data = jsonb_set(data, '{recordId}', to_jsonb($2::text)) WHERE id = $1 RETURNING id`,
  listDecisions: `SELECT data FROM cognitive_hub_decisions
    WHERE ($1::text IS NULL OR intent_id = $1) AND ($2::jsonb IS NULL OR data -> 'tags' @> $2::jsonb)
    ORDER BY created_at, id LIMIT $3`,
};
const uniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
const parse = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) : value;
const count = (rows: readonly Record<string, unknown>[], key: string): number => Number(rows[0]?.[key] ?? 0);
/** When the host should look at a run at the latest: now for active/stopping, the earliest time bound while waiting. */
const wakeAt = (run: Run): number | null => {
  if (run.status === 'active' || run.status === 'stopping') return run.updatedAt;
  if (run.status === 'deliberating' && run.outbox && !run.outbox.delivered) return run.outbox.retryAt;
  if (run.status !== 'waiting') return null;
  const times = run.wait.flatMap(c => c.kind === 'time' ? [c.at] : []);
  return times.length ? Math.min(...times) : null;
};

export class PgJournal implements ExecutionJournal {
  readonly #sql: SqlClient;
  constructor(client: SqlClient) { this.#sql = client; }
  #record(data: unknown): ExecutionRecord {
    const value = parse(data);
    assertRecord(value);
    return immutable(value);
  }
  async get(id: string): Promise<ExecutionRecord | undefined> {
    const { rows } = await this.#sql.query(SQL.record, [id]);
    const row = rows[0];
    return row ? this.#record(row.data) : undefined;
  }
  async claim(record: ExecutionRecord): Promise<Claim> {
    assertRecord(record);
    ensure(record.status === 'submitted' && record.revision === 0, 'invalid-record', 'Initial record must be submitted');
    const tenant = record.intent.scope[0]!;
    let inserted: number;
    try {
      const { rows } = await this.#sql.query(SQL.claim, [record.id, tenant, record.status, record.fingerprint,
        JSON.stringify(record), record.updatedAt, JSON.stringify(record.action.resources)]);
      inserted = count(rows, 'inserted');
    } catch (error) {
      if (uniqueViolation(error)) return { kind: 'conflict', reason: 'A resource has an unresolved operation' };
      throw error;
    }
    if (inserted === 1) return { kind: 'claimed' };
    const existing = await this.get(record.id);
    ensure(existing, 'journal-conflict', 'Record vanished during claim');
    return existing.fingerprint === record.fingerprint
      ? { kind: 'existing', record: existing }
      : { kind: 'conflict', reason: 'Operation ID already belongs to a different action' };
  }
  async replace(record: ExecutionRecord, expectedRevision: number): Promise<void> {
    assertRecord(record);
    ensure(record.revision === expectedRevision + 1, 'journal-conflict', 'Execution record version conflict');
    const { rows } = await this.#sql.query(SQL.replace, [record.id, record.revision, record.status, JSON.stringify(record),
      record.updatedAt, expectedRevision, record.fingerprint]);
    if (count(rows, 'updated') === 1) return;
    const current = await this.get(record.id);
    ensure(current && current.revision === expectedRevision, 'journal-conflict', 'Execution record version conflict');
    ensure(!terminal(current.status), 'terminal-record', 'A terminal result cannot be overwritten');
    throw new HubError('invalid-record', 'Action identity is immutable');
  }
  async unsettled(): Promise<readonly ExecutionRecord[]> {
    const { rows } = await this.#sql.query(SQL.unsettledRecords);
    return rows.map(row => this.#record(row.data));
  }
}

export class PgRunStore implements RunStore {
  readonly #sql: SqlClient;
  constructor(client: SqlClient) { this.#sql = client; }
  #run(data: unknown): Run {
    const value = parse(data);
    assertJson(value);
    const run = value as unknown as Run;
    identifier(run.id, 'run id');
    ensure(typeof run.status === 'string' && Number.isInteger(run.revision), 'invalid-run', 'Stored run is malformed');
    return immutable(run);
  }
  async create(run: Run): Promise<void> {
    assertJson(run as unknown); identifier(run.id, 'run id');
    ensure(run.revision === 0, 'invalid-run', 'A new run starts at revision 0');
    let rows: readonly Record<string, unknown>[];
    try {
      ({ rows } = await this.#sql.query(SQL.createRun, [run.id, run.intent.scope[0]!, run.intent.id, run.revision, run.status,
        wakeAt(run), JSON.stringify(run), run.updatedAt]));
    } catch (error) {
      if (uniqueViolation(error)) throw new HubError('run-exists', 'An unsettled run already exists for this intent');
      throw error;
    }
    ensure(rows.length === 1, 'run-exists', `Run ${run.id} already exists`);
  }
  async get(id: string): Promise<Run | undefined> {
    const { rows } = await this.#sql.query(SQL.run, [id]);
    const row = rows[0];
    return row ? this.#run(row.data) : undefined;
  }
  async replace(run: Run, expectedRevision: number): Promise<void> {
    assertJson(run as unknown); identifier(run.id, 'run id');
    ensure(run.revision === expectedRevision + 1, 'run-conflict', 'Run version conflict');
    const { rows } = await this.#sql.query(SQL.replaceRun, [run.id, run.revision, run.status, wakeAt(run), JSON.stringify(run),
      run.updatedAt, expectedRevision]);
    if (rows.length === 1) return;
    const current = await this.get(run.id);
    ensure(current, 'run-conflict', 'Run version conflict');
    ensure(!runTerminal(current.status), 'run-terminal', 'A finished run cannot be changed');
    throw new HubError('run-conflict', 'Run version conflict');
  }
  async markEvent(runId: string, key: string): Promise<boolean> {
    identifier(runId, 'run id'); identifier(key, 'event key');
    const { rows } = await this.#sql.query(SQL.markEvent, [runId, key]);
    return rows.length === 1;
  }
  async unsettled(): Promise<readonly Run[]> {
    const { rows } = await this.#sql.query(SQL.unsettledRuns);
    return rows.map(row => this.#run(row.data));
  }
}

export class PgDecisionStore implements DecisionStore {
  readonly #sql: SqlClient;
  constructor(client: SqlClient) { this.#sql = client; }
  #decision(data: unknown): DecisionRecord {
    const value = parse(data);
    assertJson(value);
    const record = value as unknown as DecisionRecord;
    identifier(record.id, 'decision id');
    return immutable(record);
  }
  async append(record: DecisionRecord): Promise<void> {
    assertJson(record as unknown); identifier(record.id, 'decision id');
    const { rows } = await this.#sql.query(SQL.appendDecision,
      [record.id, record.scope[0] ?? '', record.intentId, record.createdAt, JSON.stringify(record)]);
    ensure(rows.length === 1, 'duplicate-decision', `Duplicate decision ${record.id}`);
  }
  async link(id: string, recordId: string): Promise<void> {
    identifier(id, 'decision id'); identifier(recordId, 'record id');
    const { rows } = await this.#sql.query(SQL.linkDecision, [id, recordId]);
    ensure(rows.length === 1, 'unknown-decision', `Unknown decision ${id}`);
  }
  async list(query: { readonly intentId?: string; readonly tag?: { readonly key: string; readonly value: string }; readonly limit?: number } = {}):
    Promise<readonly DecisionRecord[]> {
    const tag = query.tag ? JSON.stringify({ [query.tag.key]: query.tag.value }) : null;
    const { rows } = await this.#sql.query(SQL.listDecisions, [query.intentId ?? null, tag, query.limit ?? null]);
    return rows.map(row => this.#decision(row.data));
  }
}
