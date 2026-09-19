import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { PgJournal, PgRunStore, migrate } from '../dist/pg.js';
import { boot, createPlatform, spec } from './runtime-host.mjs';

// The v0.2 acceptance chain over the PostgreSQL stores. A "restart" is a fresh plugin host and runtime over the same database.
test('the acceptance chain runs unchanged over PostgreSQL stores, including a lost receipt and a restart', async () => {
  const db = new PGlite(); await migrate(db);
  const stores = () => ({ journal: new PgJournal(db), runs: new PgRunStore(db) });
  const platform = createPlatform();
  const a = await boot(platform, stores());
  const run = await a.runtime.start(spec());
  assert.equal((await a.runtime.step(run.id)).outcome, 'waiting'); a.host.complete();
  platform.loseReceipt = true;
  const lost = await a.runtime.step(run.id);
  assert.equal(lost.outcome, 'waiting'); assert.equal(platform.submissions, 2);
  const [, second] = lost.run.operations;
  assert.equal((await a.runtime.hub.journal.get(second)).status, 'unknown');
  platform.loseReceipt = false;

  const b = await boot(platform, { ...stores(), clock: a.clock });
  assert.deepEqual((await b.runtime.runs.unsettled()).map(r => r.id), [run.id]);
  const recovered = await b.runtime.step(run.id);
  assert.equal(recovered.outcome, 'waiting'); assert.equal(platform.submissions, 2);
  assert.equal((await b.runtime.hub.journal.get(second)).status, 'pending');
  b.host.complete();
  const asked = await b.runtime.step(run.id);
  assert.equal(asked.outcome, 'deliberating');
  const request = b.inbox.pending().at(-1);
  platform.info = 'route-B';
  assert.equal((await b.runtime.respond(run.id, { kind: 'fact', requestId: request.id, intentRevision: 1, note: null })).kind, 'applied');
  assert.equal((await b.runtime.step(run.id)).outcome, 'waiting'); b.host.complete();
  const done = await b.runtime.step(run.id);
  assert.equal(done.outcome, 'completed'); assert.equal(platform.submissions, 3);
  assert.deepEqual((await b.runtime.runs.unsettled()), []);
  const { rows } = await db.query('SELECT count(*)::int AS locks FROM cognitive_hub_locks');
  assert.equal(rows[0].locks, 0);
  assert.equal((await db.query('SELECT status FROM cognitive_hub_runs WHERE id = $1', [run.id])).rows[0].status, 'completed');
  await db.close();
});

test('two runtimes over one database cannot both own a step', async () => {
  const db = new PGlite(); await migrate(db);
  const platform = createPlatform(); platform.info = 'given';
  const a = await boot(platform, { journal: new PgJournal(db), runs: new PgRunStore(db), owner: 'worker-a' });
  const b = await boot(platform, { journal: new PgJournal(db), runs: new PgRunStore(db), owner: 'worker-b', clock: a.clock });
  const run = await a.runtime.start(spec());
  const [first, second] = await Promise.all([a.runtime.step(run.id), b.runtime.step(run.id)]);
  const outcomes = [first.outcome, second.outcome].sort();
  assert.deepEqual(outcomes, ['lease-held', 'waiting']);
  assert.equal(platform.submissions, 1);
  await db.close();
});
