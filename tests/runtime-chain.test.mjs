import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryJournal, MemoryRunStore } from '../dist/index.js';
import { boot, createPlatform, spec } from './runtime-host.mjs';

// The v0.2 acceptance chain, in one process: step one done → step two loses its receipt → the process "dies" →
// a fresh runtime rebuilds from exported JSON and settles the open operation by query → a fact is missing →
// a human supplies it → the remaining step runs → the goal evaluator confirms → the run stops.
test('a delegated goal survives a lost receipt and a restart, asks once, and completes without a duplicate action', async () => {
  const platform = createPlatform();
  const a = await boot(platform);
  const run = await a.runtime.start(spec());
  assert.equal((await a.runtime.step(run.id)).outcome, 'waiting'); a.host.complete();
  platform.loseReceipt = true;
  const lost = await a.runtime.step(run.id);
  assert.equal(lost.outcome, 'waiting'); assert.equal(platform.submissions, 2);
  const [, second] = lost.run.operations;
  assert.equal((await a.runtime.hub.journal.get(second)).status, 'unknown');
  platform.loseReceipt = false;

  // Crash: process A is abandoned with its leases. B rebuilds every store from JSON and the platform is what it is.
  const snapshot = JSON.parse(JSON.stringify({ journal: a.runtime.hub.journal.entries(), runs: a.runtime.runs.entries(), events: a.runtime.runs.events() }));
  const b = await boot(platform, { journal: new MemoryJournal(snapshot.journal), runs: new MemoryRunStore(snapshot.runs, snapshot.events), clock: a.clock });
  const recovered = await b.runtime.step(run.id);
  assert.equal(recovered.outcome, 'waiting'); assert.equal(platform.submissions, 2);
  assert.equal((await b.runtime.hub.journal.get(second)).status, 'pending');
  assert.ok(b.events.entries().some(e => e.type === 'execution.recovered' && e.data.id === second));
  b.host.complete();

  const asked = await b.runtime.step(run.id);
  assert.equal(asked.outcome, 'deliberating'); assert.equal((await b.runtime.hub.journal.get(second)).status, 'verified');
  const request = b.inbox.pending().at(-1);
  assert.equal(request.runId, run.id); assert.equal(request.kind, 'decision');
  platform.info = 'route-B';
  assert.equal((await b.runtime.respond(run.id, { kind: 'fact', requestId: request.id, intentRevision: 1, note: 'route-B' })).kind, 'applied');
  assert.equal((await b.runtime.step(run.id)).outcome, 'waiting'); b.host.complete();
  const done = await b.runtime.step(run.id);
  assert.equal(done.outcome, 'completed'); assert.equal(done.run.status, 'completed');
  assert.equal(platform.submissions, 3); assert.equal(done.run.counters.actions, 3); assert.equal(done.run.counters.decisions, 4);
  assert.deepEqual(done.run.answers.map(x => x.kind), ['fact']);
  assert.equal((await b.runtime.deliver(run.id, { key: 'late', type: 'state-changed', data: null })).accepted, false);
  await b.host.plugins.stop('sim');
});
