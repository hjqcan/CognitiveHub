import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDecisionStore } from '../dist/index.js';
import { boot, createPlatform, spec } from './runtime-host.mjs';
import { fixture, intent } from './fixtures.mjs';

// Stage 2 without the fact the last stage needs: the capability offers nothing until the fact arrives.
const idleSpec = (changes = {}) => spec({ intent: { ...spec().intent, id: 'idle-1' }, idle: 'wait', ...changes });

test('an empty candidate set still asks for deliberation by default', async () => {
  const platform = createPlatform(); platform.stage = 2;
  const { runtime, host, inbox } = await boot(platform);
  const run = await runtime.start(spec());
  const asked = await runtime.step(run.id);
  assert.equal(asked.outcome, 'deliberating'); assert.equal(asked.run.request.kind, 'decision');
  assert.equal(inbox.pending().length, 1);
  await runtime.stop(run.id); await runtime.step(run.id);
  await host.plugins.stop('sim');
});

test('an idle run waits for a state change instead of asking, then acts when a candidate appears', async () => {
  const platform = createPlatform(); platform.stage = 2;
  const decisions = new MemoryDecisionStore();
  const { runtime, host, inbox } = await boot(platform, { decisions });
  const run = await runtime.start(idleSpec({ waitMs: 1000 }));
  assert.equal(run.idle, 'wait');
  const waited = await runtime.step(run.id);
  assert.equal(waited.outcome, 'waiting'); assert.equal(waited.run.request, null);
  assert.deepEqual(waited.run.wait.map(c => c.kind), ['state', 'time']);
  assert.equal(inbox.pending().length, 0, 'no deliberation request for an empty turn');
  const record = decisions.entries().at(-1);
  assert.equal(record.outcome, 'wait'); assert.equal(record.decision, null); assert.equal(record.code, null);
  assert.deepEqual(record.considered.map(c => c.drafts), [0]);
  assert.equal((await runtime.step(run.id)).outcome, 'waiting', 'same version, before the time bound: nothing happens');
  platform.info = 'given';                                   // the world changes: the state version differs
  const acted = await runtime.step(run.id);
  assert.equal(acted.outcome, 'waiting'); assert.equal(platform.submissions, 1);
  host.complete();
  assert.equal((await runtime.step(run.id)).outcome, 'completed');
  await host.plugins.stop('sim');
});

test('timed wake-ups of an idle run on an unchanged state count as no progress', async () => {
  const platform = createPlatform(); platform.stage = 2;
  const { runtime, host, clock } = await boot(platform);
  const run = await runtime.start(idleSpec({ waitMs: 1000, budget: { maxDecisions: 20, maxActions: 10, maxNoProgress: 3, deadlineAt: null } }));
  let result = await runtime.step(run.id);
  for (let i = 0; i < 6 && result.outcome === 'waiting'; i++) { clock.now += 1001; result = await runtime.step(run.id); }
  assert.equal(result.outcome, 'deliberating'); assert.equal(result.run.request.kind, 'no-progress');
  assert.equal(platform.submissions, 0);
  await host.plugins.stop('sim');
});

test('the hub itself can return a wait for an empty candidate set', async () => {
  const f = await fixture({ capability: { prepare: async () => [] } });
  const asked = await f.hub.propose(intent());
  assert.equal(asked.kind, 'deliberation'); assert.equal(f.inbox.pending().length, 1);
  const waited = await f.hub.propose(intent(), { onEmpty: 'wait' });
  assert.equal(waited.kind, 'wait'); assert.equal(f.inbox.pending().length, 1);
  await assert.rejects(f.hub.propose(intent(), { onEmpty: 'later' }), { code: 'invalid-options' });
});
