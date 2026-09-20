import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { PgJournal, PgRunStore, migrate, SCHEMA_VERSION } from '../dist/pg.js';
import { fixture, spec } from './v021-fixtures.mjs';

const storage = async t => {
  const db = new PGlite(); t.after(() => db.close()); await migrate(db);
  return { db, runs: new PgRunStore(db), journal: new PgJournal(db) };
};

test('v3 migration preserves old event receipts and supports full-scope uniqueness on every rerun', async t => {
  const { db, runs, journal } = await storage(t);
  const f = await fixture({ runs, journal }); const first = await f.runtime.start(spec());
  // Simulate the old v2 unique index and a snapshot that did not have an inline inbox.
  await db.query('DROP INDEX cognitive_hub_runs_one_unsettled_per_scope_intent');
  await db.query(`CREATE UNIQUE INDEX cognitive_hub_runs_one_unsettled_per_intent
    ON cognitive_hub_runs (tenant, intent_id) WHERE status NOT IN ('completed', 'failed', 'stopped')`);
  await db.query(`UPDATE cognitive_hub_runs SET data = data - 'processedEvents' WHERE id = $1`, [first.id]);
  await db.query('INSERT INTO cognitive_hub_run_events (run_id, key) VALUES ($1, $2)', [first.id, 'old-event']);
  await db.query('DELETE FROM cognitive_hub_schema WHERE version = 3');
  await migrate(db);
  assert.deepEqual((await runs.get(first.id)).processedEvents, ['old-event']);
  assert.deepEqual(await f.runtime.deliver(first.id, { key: 'old-event', type: 'host', data: null }),
    { accepted: false, woke: false });
  const settings = spec();
  const second = await f.runtime.start({ ...settings, intent: { ...settings.intent, scope: ['tenant', 'other-device'] } });
  assert.ok(second.id !== first.id);
  await assert.rejects(f.runtime.start(settings), { code: 'run-exists' });
  await migrate(db); await migrate(db); // Must not recreate the old index over now-valid rows.
  const versions = (await db.query('SELECT version FROM cognitive_hub_schema ORDER BY version')).rows.map(r => r.version);
  assert.deepEqual(versions, Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1));
  assert.equal((await runs.unsettled()).length, 2);
});

test('PostgreSQL wake-up failure does not consume its event; retry after restart wakes the Run', async t => {
  const { db, journal } = await storage(t); let fail = true;
  const runs = new PgRunStore({ async query(sql, values) {
    if (fail && sql.includes('UPDATE cognitive_hub_runs SET') && JSON.parse(values[4]).processedEvents?.includes('wake-1')) {
      fail = false; throw new Error('database unavailable');
    }
    return db.query(sql, values);
  } });
  const f = await fixture({ runs, journal }); f.control.mode = 'wait';
  const run = await f.runtime.start(spec()); await f.runtime.step(run.id);
  const event = { key: 'wake-1', type: 'host', data: null };
  await assert.rejects(f.runtime.deliver(run.id, event), /database unavailable/);
  const g = await fixture({ runs: new PgRunStore(db), journal, control: f.control });
  assert.deepEqual(await g.runtime.deliver(run.id, event), { accepted: true, woke: true });
  assert.deepEqual(await g.runtime.deliver(run.id, event), { accepted: false, woke: false });
});

test('PostgreSQL outbox recovers the same question after successful delivery but failed acknowledgment', async t => {
  const { db, journal } = await storage(t); let fail = true;
  const runs = new PgRunStore({ async query(sql, values) {
    if (fail && sql.includes('UPDATE cognitive_hub_runs SET') && JSON.parse(values[4]).outbox?.delivered) {
      fail = false; throw new Error('acknowledgment failed');
    }
    return db.query(sql, values);
  } });
  const seen = [];
  const inbox = { async request(message) { seen.push(message.id); } };
  const f = await fixture({ runs, journal, inbox }); f.control.mode = 'ask';
  const run = await f.runtime.start(spec());
  await assert.rejects(f.runtime.step(run.id), /acknowledgment failed/);
  const saved = await runs.get(run.id);
  assert.equal(saved.status, 'deliberating'); assert.equal(saved.outbox.delivered, false);
  const g = await fixture({ runs: new PgRunStore(db), journal, inbox, control: f.control });
  await g.runtime.step(run.id);
  assert.deepEqual(seen, [saved.request.id, saved.request.id]);
  assert.equal((await g.runs.get(run.id)).outbox.delivered, true);
  const result = await g.runtime.respond(run.id, { kind: 'fact', requestId: saved.request.id, intentRevision: 1, note: null });
  assert.equal(result.kind, 'applied'); assert.equal(result.run.outbox, null);
});
