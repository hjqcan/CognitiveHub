import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { HumanInbox, IntentRuntime, MemoryJournal, MemoryRunStore, PluginHost } from '../dist/index.js';
import { PgJournal, PgRunStore, migrate } from '../dist/pg.js';
import { fixture, intent } from './fixtures.mjs';

// Per-step work must not grow with a run's history. These tests count calls, never time: a counter that grows with the
// number of past actions is the regression, whatever the machine speed.

const wrap = (object, method, counts, key) => {
  const original = object[method].bind(object);
  object[method] = async (...args) => { counts[key]++; return original(...args); };
};

/** One run over a counter capability. `accepted` receipts settle on the next reconcile; otherwise each action completes at once. */
async function scaleHost({ stores = { journal: new MemoryJournal(), runs: new MemoryRunStore() }, accepted = false, sql, goal, runId } = {}) {
  const world = { version: 0, now: 1_000_000, mode: 'action', tasks: new Set(), submits: 0, lastGoal: null };
  const counts = { get: 0, reconcile: 0, replace: 0, observe: 0, decide: 0, sql: 0 };
  const plugins = new PluginHost();
  plugins.install({ manifest: { apiVersion: 1, id: 'scale', version: '1.0.0' }, setup(ctx) {
    ctx.capability({ id: 'scale.act@1', description: 'Advance the counter', effect: 'write',
      async prepare() { return [{ key: 'advance', description: 'Advance the counter by one', input: { n: 1 }, resources: ['counter'] }]; },
      validate() {}, async check() { return true; },
      async execute({ idempotencyKey }) {
        world.submits++; world.version++; world.tasks.add(idempotencyKey);
        return accepted ? { status: 'accepted', handle: idempotencyKey, evidence: null } : { status: 'completed', evidence: null };
      },
      async reconcile({ idempotencyKey }) {
        return world.tasks.has(idempotencyKey) ? { status: 'completed', evidence: null } : { status: 'unknown', reason: 'No task for this key' };
      },
      async verify({ idempotencyKey }) { return { status: world.tasks.has(idempotencyKey) ? 'verified' : 'pending', evidence: null }; },
    });
  } }, ['scale-tenant']);
  await plugins.start();
  wrap(stores.journal, 'get', counts, 'get');
  wrap(stores.runs, 'replace', counts, 'replace');
  if (sql) sql.onQuery = () => { counts.sql++; };
  const runtime = new IntentRuntime({ plugins, journal: stores.journal, runs: stores.runs, owner: 'scale-worker', now: () => world.now,
    deliberation: new HumanInbox(),
    state: { async observe() {
      counts.observe++;
      return { version: `v${world.version}`, observedAt: world.now, validUntil: world.now + 60000, facts: { version: world.version } };
    } },
    decision: { name: 'scale-decider', async decide(request) {
      counts.decide++;
      return world.mode === 'wait' ? { kind: 'wait', reason: 'Nothing to do yet' } : { kind: 'action', candidateId: request.candidates[0].id };
    } },
    policy: { async check() { return { allowed: true, version: 'scale-policy', reason: 'test scope' }; } },
    goal: goal ?? { async evaluate(input) { world.lastGoal = input; return { status: 'unsatisfied', evidence: null }; } },
  });
  wrap(runtime.hub, 'reconcile', counts, 'reconcile');
  const run = runId ? await runtime.get(runId) : await runtime.start({ approval: 'automatic', waitMs: 1000,
    intent: { id: 'counter', revision: 1, scope: ['scale-tenant'], objective: 'Advance the counter', constraints: [], capabilities: ['scale.act@1'] },
    budget: { maxDecisions: 100_000, maxActions: 100_000, maxNoProgress: 5, deadlineAt: null } });
  const step = async () => {
    const before = { ...counts };
    const result = await runtime.step(run.id);
    world.now += 10;
    return { outcome: result.outcome, run: result.run, ...Object.fromEntries(Object.keys(counts).map(k => [k, counts[k] - before[k]])) };
  };
  return { runtime, run, world, counts, plugins, stores, step };
}
const profile = async (host, steps) => { const rows = []; for (let i = 0; i < steps; i++) rows.push(await host.step()); return rows; };
const work = ({ outcome, get, reconcile, replace, observe, decide, sql }) => ({ outcome, get, reconcile, replace, observe, decide, sql });

/** A counting SqlClient over PGlite. */
async function pglite() {
  const db = new PGlite(); await migrate(db);
  const client = { onQuery: null, query(text, values) { client.onQuery?.(); return db.query(text, values ? [...values] : []); } };
  return { db, client };
}

test('per-step work stays flat as a run accumulates completed actions (memory)', async () => {
  const host = await scaleHost();
  const rows = await profile(host, 200);
  const steady = work(rows[9]);
  assert.deepEqual(steady, { outcome: 'executed', get: 2, reconcile: 0, replace: 4, observe: 2, decide: 1, sql: 0 });
  rows.slice(9).forEach((row, i) => assert.deepEqual(work(row), steady, `step ${i + 10}`));
  const last = rows.at(-1).run;
  assert.equal(last.operations.length, 200); assert.equal(last.settled, 199); assert.equal(host.world.submits, 200);
  assert.equal(last.lease, null);
  await host.plugins.stop('scale');
});

test('per-step SQL stays flat on PostgreSQL stores', async () => {
  const { db, client } = await pglite();
  const host = await scaleHost({ stores: { journal: new PgJournal(client), runs: new PgRunStore(client) }, sql: client });
  const rows = await profile(host, 200);
  const steady = work(rows[9]);
  assert.equal(steady.outcome, 'executed'); assert.equal(steady.get, 2); assert.equal(steady.replace, 4);
  assert.ok(steady.sql <= 10, `expected at most 10 statements per step, saw ${steady.sql}`);
  rows.slice(9).forEach((row, i) => assert.deepEqual(work(row), steady, `step ${i + 10}`));
  assert.equal((await host.runtime.get(host.run.id)).settled, 199);
  await host.plugins.stop('scale'); await db.close();
});

test('accepted receipts cost one reconcile and four run writes per step, however long the run', async () => {
  const host = await scaleHost({ accepted: true });
  const rows = await profile(host, 120);
  const steady = work(rows[9]);
  assert.deepEqual(steady, { outcome: 'waiting', get: 3, reconcile: 1, replace: 4, observe: 2, decide: 1, sql: 0 });
  rows.slice(9).forEach((row, i) => assert.deepEqual(work(row), steady, `step ${i + 10}`));
  assert.equal(rows.at(-1).run.lease, null, 'the lease is released in the step\'s last write');
  assert.equal(rows.at(-1).run.settled, 119);
  // The last operation is still open and holds the plugin; stopping the run reconciles it first.
  await host.runtime.stop(host.run.id);
  assert.equal((await host.runtime.step(host.run.id)).outcome, 'stopped');
  await host.plugins.stop('scale');
});

test('a run persisted before the cursor existed catches up once, then stays flat', async () => {
  const host = await scaleHost();
  await profile(host, 50);
  const legacy = host.stores.runs.entries().map(r => { const { settled, ...rest } = r; return rest; });
  const journal = new MemoryJournal(host.stores.journal.entries());
  const again = await scaleHost({ stores: { journal, runs: new MemoryRunStore(legacy) }, runId: host.run.id });
  Object.assign(again.world, { version: host.world.version, now: host.world.now, tasks: host.world.tasks });
  const first = await again.step();
  assert.equal(first.outcome, 'executed'); assert.equal(first.get, 51, 'one read per past operation, once');
  assert.equal(first.run.settled, 50);
  const second = await again.step();
  assert.equal(second.get, 2);
  await host.plugins.stop('scale'); await again.plugins.stop('scale');
});

test('the goal sees each operation once it is terminal, plus every operation id', async () => {
  const host = await scaleHost();
  await profile(host, 3);
  const seen = host.world.lastGoal;
  const run = await host.runtime.get(host.run.id);
  assert.deepEqual(seen.operations, run.operations.slice(0, 2), 'ids as of the evaluation, before the third dispatch');
  assert.deepEqual(seen.records.map(r => r.id), [run.operations[1]]);
  assert.equal(seen.records[0].status, 'verified');
  await host.plugins.stop('scale');
});

for (const settled of [999, 1.5, -3, 'x']) test(`a malformed cursor (${JSON.stringify(settled)}) reads as zero and the run keeps working`, async () => {
  const host = await scaleHost();
  await profile(host, 5);
  const current = await host.runtime.get(host.run.id);
  await host.stores.runs.replace({ ...current, revision: current.revision + 1, settled }, current.revision);
  const next = await host.step();
  assert.equal(next.outcome, 'executed'); assert.equal(next.get, 6); assert.equal(next.run.settled, 5);
  assert.equal(host.world.submits, 6);
  await host.plugins.stop('scale');
});

test('a phantom operation past the cursor is dropped without disturbing the settled prefix', async () => {
  const host = await scaleHost();
  await profile(host, 4);
  const current = await host.runtime.get(host.run.id);
  assert.equal(current.settled, 3);
  await host.stores.runs.replace({ ...current, revision: current.revision + 1, operations: [...current.operations, 'phantom'],
    counters: { ...current.counters, actions: current.counters.actions + 1 } }, current.revision);
  const next = await host.step();
  assert.equal(next.outcome, 'executed'); assert.equal(host.world.submits, 5);
  assert.ok(!next.run.operations.includes('phantom')); assert.equal(next.run.operations.length, 5); assert.equal(next.run.settled, 4);
  await host.plugins.stop('scale');
});

test('stop only looks past the cursor for open operations', async () => {
  const host = await scaleHost();
  await profile(host, 30);
  const before = host.counts.get;
  const stopped = await host.runtime.stop(host.run.id);
  assert.equal(stopped.kind, 'applied'); assert.equal(stopped.run.status, 'stopped');
  assert.equal(host.counts.get - before, 1);
  await host.plugins.stop('scale');
});

test('a quiet waiting run is checked without a lease, a journal read or a write', async () => {
  const host = await scaleHost();
  await profile(host, 3);
  host.world.mode = 'wait';
  const parked = await host.step();
  assert.equal(parked.outcome, 'waiting'); assert.equal(parked.run.lease, null);
  assert.deepEqual(parked.run.wait.map(c => c.kind), ['state', 'time']);
  const quiet = await host.step();
  assert.deepEqual(work(quiet), { outcome: 'waiting', get: 0, reconcile: 0, replace: 0, observe: 1, decide: 0, sql: 0 });
  assert.equal(quiet.run.revision, parked.run.revision);
  host.world.version++;                                   // the world changes: the state condition holds
  host.world.mode = 'action';
  const woken = await host.step();
  assert.equal(woken.outcome, 'executed');
  assert.equal(woken.observe, 2, 'the quiet check\'s observation is reused by the step and by propose; execute observes again');
  await host.plugins.stop('scale');
});

test('a quiet check still takes the full path for a leftover lease or a passed time bound', async () => {
  const host = await scaleHost();
  host.world.mode = 'wait';
  const parked = await host.step();
  const run = parked.run;
  await host.stores.runs.replace({ ...run, revision: run.revision + 1, lease: { owner: 'scale-worker', expiresAt: host.world.now + 60000 } }, run.revision);
  const cleared = await host.step();
  assert.ok(cleared.replace > 0); assert.equal(cleared.run.lease, null);
  host.world.now = cleared.run.wait.find(c => c.kind === 'time').at;
  const timed = await host.step();
  assert.equal(timed.decide, 1, 'a passed time bound re-decides');
  // A time-only wake-up on an unchanged state and the repeated wait on that state each count (docs/runtime.md §6).
  assert.equal(timed.run.counters.noProgress, 2);
  await host.plugins.stop('scale');
});

test('a quiet check racing a host event neither conflicts nor loses the wake-up', async () => {
  const host = await scaleHost();
  host.world.mode = 'wait';
  await host.step();
  const [stepped, delivered] = await Promise.all([
    host.runtime.step(host.run.id), host.runtime.deliver(host.run.id, { key: 'nudge-1', type: 'host', data: null })]);
  assert.equal(stepped.outcome, 'waiting'); assert.deepEqual(delivered, { accepted: true, woke: true });
  assert.equal((await host.runtime.get(host.run.id)).status, 'active');
  await host.plugins.stop('scale');
});

test('two runtimes over one database: quiet checks never conflict with deliveries', async () => {
  const { db, client } = await pglite();
  const stores = () => ({ journal: new PgJournal(client), runs: new PgRunStore(client) });
  const a = await scaleHost({ stores: stores() });
  a.world.mode = 'wait';
  await a.step();
  const b = new IntentRuntime({ plugins: a.plugins, ...stores(), owner: 'other-worker', now: () => a.world.now, deliberation: new HumanInbox(),
    state: { async observe() { return { version: `v${a.world.version}`, observedAt: a.world.now, validUntil: a.world.now + 60000, facts: null }; } },
    decision: { name: 'unused', async decide() { throw new Error('not called'); } },
    policy: { async check() { return { allowed: true, version: 'scale-policy', reason: 'test scope' }; } },
    goal: { async evaluate() { return { status: 'unsatisfied', evidence: null }; } } });
  for (let i = 0; i < 20; i++) {
    const [stepped] = await Promise.all([a.runtime.step(a.run.id), b.deliver(a.run.id, { key: `event-${i}`, type: 'state-changed', data: { version: `v${a.world.version}` } })]);
    assert.equal(stepped.outcome, 'waiting');
  }
  assert.equal((await b.get(a.run.id)).processedEvents.length, 20);
  await a.plugins.stop('scale'); await db.close();
});

test('propose reuses a valid supplied observation and observes afresh when it is stale', async () => {
  let observed = 0, f;
  f = await fixture({ hub: { state: { observe: async () => {
    observed++; return { version: f.control.version, observedAt: f.control.now, validUntil: f.control.now + 10000, facts: { blocked: true } };
  } } } });
  const supplied = { version: 'v1', observedAt: f.control.now, validUntil: f.control.now + 5000, facts: { blocked: true } };
  const reused = await f.hub.propose(intent(), { observation: supplied });
  assert.equal(reused.kind, 'proposal'); assert.equal(reused.stateVersion, 'v1'); assert.equal(observed, 0);
  const stale = await f.hub.propose(intent({ id: 'task-2' }), { observation: { ...supplied, validUntil: f.control.now } });
  assert.equal(stale.kind, 'proposal'); assert.equal(observed, 1);
  f.control.version = 'v2';                               // execute still observes and catches the change
  const rejected = await f.hub.execute(reused.id, 'op', { live: true });
  assert.equal(rejected.kind, 'rejected'); assert.equal(rejected.code, 'stale-state'); assert.equal(f.control.calls, 0);
});
