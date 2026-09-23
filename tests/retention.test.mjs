import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { HumanInbox, IntentRuntime, MemoryDecisionStore, MemoryJournal, MemoryRunStore, PluginHost } from '../dist/index.js';
import { PgDecisionStore, PgJournal, PgRunStore, migrate } from '../dist/pg.js';
import { fixture, intent } from './fixtures.mjs';

// Retention without losing what an active run still needs: runtime.prune() keeps every journal record an unsettled run
// refers to; finished runs, their records and old decision records go.

async function workers(stores) {
  const counters = new Map(), goals = new Map();
  const plugins = new PluginHost();
  plugins.install({ manifest: { apiVersion: 1, id: 'workers', version: '1.0.0' }, setup(ctx) {
    ctx.capability({ id: 'workers.advance@1', description: 'Advance this worker', effect: 'write',
      async prepare({ intent }) { return [{ key: 'advance', description: 'Advance', input: { worker: intent.id }, resources: [`worker:${intent.id}`] }]; },
      validate() {}, async check() { return true; },
      async execute({ action }) { counters.set(action.input.worker, (counters.get(action.input.worker) ?? 0) + 1); return { status: 'completed', evidence: null }; },
      async verify() { return { status: 'verified', evidence: null }; } });
  } }, ['retention']);
  await plugins.start();
  const clock = { now: 1_000_000 }, seen = new Map();
  const runtime = new IntentRuntime({ plugins, ...stores, owner: 'retention-worker', now: () => clock.now, deliberation: new HumanInbox(),
    state: { async observe(intent) {
      const v = counters.get(intent.id) ?? 0;
      return { version: `${intent.id}:${v}`, observedAt: clock.now, validUntil: clock.now + 60000, facts: { count: v, filler: 'x'.repeat(200) } };
    } },
    decision: { name: 'first', async decide(r) { return { kind: 'action', candidateId: r.candidates[0].id }; } },
    policy: { async check() { return { allowed: true, version: 'p', reason: 'retention test' }; } },
    goal: { async evaluate({ intent, records }) {
      seen.set(intent.id, records.map(r => r.status));
      return { status: (counters.get(intent.id) ?? 0) >= goals.get(intent.id) ? 'satisfied' : 'unsatisfied', evidence: null };
    } } });
  const start = async (id, goal) => {
    goals.set(id, goal);
    return runtime.start({ approval: 'automatic', budget: { maxDecisions: 50, maxActions: 50, maxNoProgress: 5, deadlineAt: null },
      intent: { id, revision: 1, scope: ['retention'], objective: 'Advance this worker', constraints: [], capabilities: ['workers.advance@1'] } });
  };
  const step = async id => { const r = await runtime.step(id); clock.now += 10; return r; };
  return { runtime, clock, counters, seen, start, step, plugins };
}

for (const [name, make] of [
  ['memory', async () => ({ journal: new MemoryJournal(), runs: new MemoryRunStore(), decisions: new MemoryDecisionStore() })],
  ['PostgreSQL', async () => { const db = new PGlite(); await migrate(db);
    return { journal: new PgJournal(db), runs: new PgRunStore(db), decisions: new PgDecisionStore(db), db }; }],
]) test(`runtime.prune keeps what active runs need and removes finished history (${name})`, async () => {
  const { db, ...stores } = await make();
  const w = await workers(stores);
  const done = await w.start('finished', 2), live = await w.start('live', 6);
  for (let i = 0; i < 3; i++) { await w.step(done.id); await w.step(live.id); }
  assert.equal((await w.runtime.get(done.id)).status, 'completed');
  const liveBefore = await w.runtime.get(live.id);
  assert.equal(liveBefore.operations.length, 3);
  const pruned = await w.runtime.prune({ before: w.clock.now + 1 });
  assert.deepEqual(pruned, { runs: 1, records: 2, decisions: 5 }, 'two actions and three for the live run; the third finished step decided nothing');
  assert.equal(await w.runtime.get(done.id), undefined);
  for (const id of liveBefore.operations) assert.ok(await w.runtime.hub.journal.get(id), 'an active run keeps every record it refers to');
  const next = await w.step(live.id);
  assert.equal(next.outcome, 'executed');
  assert.deepEqual(next.run.operations.slice(0, 3), liveBefore.operations, 'no retained record is mistaken for a phantom');
  assert.deepEqual(w.seen.get('live'), ['verified']);
  await w.plugins.stop('workers'); await db?.close();
});

test('stores without prune report null instead of failing', async () => {
  const inner = new MemoryJournal();
  const journal = { claim: r => inner.claim(r), get: id => inner.get(id), replace: (r, v) => inner.replace(r, v), unsettled: () => inner.unsettled() };
  const w = await workers({ journal });
  assert.deepEqual(await w.runtime.prune({ before: w.clock.now }), { decisions: null, runs: 0, records: null });
  await assert.rejects(w.runtime.prune({ before: Infinity }), { code: 'invalid-options' });
  await w.plugins.stop('workers');
});

test('recordFacts: false keeps the decision record but drops the observation facts', async () => {
  const decisions = new MemoryDecisionStore();
  const f = await fixture({ hub: { decisions, recordFacts: false } });
  const p = await f.hub.propose(intent());
  const record = await decisions.get(p.decisionId);
  assert.equal(record.request.observation.facts, null);
  assert.equal(record.request.candidates.length, 1); assert.equal(record.request.observation.version, 'v1');
  const full = new MemoryDecisionStore();
  const g = await fixture({ hub: { decisions: full } });
  const q = await g.hub.propose(intent());
  assert.deepEqual((await full.get(q.decisionId)).request.observation.facts, { blocked: true });
});
