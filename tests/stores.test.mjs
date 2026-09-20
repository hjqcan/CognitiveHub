import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { MemoryDecisionStore, MemoryJournal, MemoryRunStore } from '../dist/index.js';
import { PgDecisionStore, PgJournal, PgRunStore, migrate, SCHEMA_VERSION } from '../dist/pg.js';
import { decisionStoreConformance, journalConformance, runStoreConformance } from './store-conformance.mjs';

journalConformance('MemoryJournal', async () => new MemoryJournal());
runStoreConformance('MemoryRunStore', async () => new MemoryRunStore());
decisionStoreConformance('MemoryDecisionStore', async () => new MemoryDecisionStore());

// PGlite is real PostgreSQL compiled to WebAssembly, so the SQL is exercised offline with genuine semantics.
let shared;
const pglite = async () => {
  if (!shared) { shared = new PGlite(); await migrate(shared); await migrate(shared); }
  return shared;
};
journalConformance('PgJournal (PGlite)', async () => new PgJournal(await pglite()));
runStoreConformance('PgRunStore (PGlite)', async () => new PgRunStore(await pglite()));
decisionStoreConformance('PgDecisionStore (PGlite)', async () => new PgDecisionStore(await pglite()));

test('the schema migration is idempotent and records every version', async () => {
  const db = await pglite(); await migrate(db);
  const { rows } = await db.query('SELECT version FROM cognitive_hub_schema ORDER BY version');
  assert.deepEqual(rows.map(r => r.version), Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1)); assert.equal(SCHEMA_VERSION, 3);
});
test('a lock collision leaves neither the record nor any of its other locks behind', async () => {
  const db = await pglite(); const journal = new PgJournal(db);
  const { record, unique } = await import('./store-conformance.mjs');
  const held = unique('res'), free = unique('res');
  await journal.claim(record({ resources: [held] }));
  const blocked = record({ resources: [free, held] });
  assert.equal((await journal.claim(blocked)).kind, 'conflict');
  const { rows } = await db.query('SELECT resource FROM cognitive_hub_locks WHERE resource = $1', [free]);
  assert.equal(rows.length, 0);
  assert.equal((await db.query('SELECT id FROM cognitive_hub_records WHERE id = $1', [blocked.id])).rows.length, 0);
});

// Optional: the same contract against a real server, when a URL and the node-postgres driver are available.
const url = process.env.COGNITIVE_HUB_PG_URL;
if (url) {
  const driver = await import('pg').catch(() => null);
  if (!driver) console.warn('COGNITIVE_HUB_PG_URL is set but the pg driver is not installed; skipping server tests');
  else {
    const pool = new driver.default.Pool({ connectionString: url });
    await migrate(pool);
    journalConformance('PgJournal (server)', async () => new PgJournal(pool));
    runStoreConformance('PgRunStore (server)', async () => new PgRunStore(pool));
    decisionStoreConformance('PgDecisionStore (server)', async () => new PgDecisionStore(pool));
    after(() => pool.end());
  }
}
after(async () => { await shared?.close(); });
