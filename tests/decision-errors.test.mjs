import test from 'node:test';
import assert from 'node:assert/strict';
import { HubError, MemoryDecisionStore, MemoryRunStore } from '../dist/index.js';
import { deferred, fixture, intent } from './fixtures.mjs';
import { boot, createPlatform, spec } from './runtime-host.mjs';

// A decider that fails transiently (rate limits, overload, a slow reply) should not park every run on a human.
// onDecisionError: 'wait' retries on the normal wait path, bounded by maxNoProgress; everything else still asks.

const failing = (make) => ({ name: 'flaky', async decide() { throw make(); } });

test('by default a decider failure still asks for deliberation', async () => {
  const { runtime, inbox } = await boot(createPlatform(), { decision: failing(() => new HubError('jev-http-429', 'rate limited')) });
  const run = await runtime.start(spec());
  const r = await runtime.step(run.id);
  assert.equal(r.outcome, 'deliberating'); assert.equal(r.code, 'jev-http-429'); assert.equal(inbox.pending().length, 1);
  assert.equal(r.run.onDecisionError, 'deliberate');
});

const decideFailures = [
  ['a thrown rate limit', { decision: failing(() => new HubError('jev-http-429', 'rate limited')) }, 'jev-http-429'],
  ['an overloaded service', { decision: failing(() => new HubError('jev-http-529', 'overloaded')) }, 'jev-http-529'],
  ['a malformed answer', { decision: { name: 'bad', async decide() { return { kind: 'action', candidateId: 'invented' }; } } }, 'invalid-decision'],
];
for (const [name, options, code] of decideFailures) test(`in wait mode ${name} becomes a timed wait carrying its code`, async () => {
  const decisions = new MemoryDecisionStore();
  const platform = createPlatform();
  const { runtime, inbox } = await boot(platform, { ...options, decisions });
  const run = await runtime.start(spec({ onDecisionError: 'wait' }));
  const r = await runtime.step(run.id);
  assert.equal(r.outcome, 'waiting'); assert.equal(r.code, code);
  assert.deepEqual(r.run.wait.map(c => c.kind), ['state', 'time']);
  assert.equal(r.run.counters.noProgress, 1); assert.equal(r.run.request, null);
  assert.equal(inbox.pending().length, 0); assert.equal(platform.submissions, 0);
  const record = await decisions.get(r.decisionId);
  assert.deepEqual([record.outcome, record.code, record.phase], ['wait', code, 'decide']);
});

test('in wait mode a decider timeout and state that expired while deciding also wait', async () => {
  const gate = deferred();
  const slow = await fixture({ hub: { decisionTimeoutMs: 10, decision: { name: 'slow', async decide() { await gate.promise; return { kind: 'wait', reason: 'late' }; } } } });
  const timedOut = await slow.hub.propose(intent(), { onDecisionError: 'wait' });
  assert.deepEqual([timedOut.kind, timedOut.code], ['wait', 'timeout']);
  gate.resolve();
  let f;
  f = await fixture({ hub: { decision: { name: 'dawdler', async decide(r) { f.control.now += 20000; return { kind: 'action', candidateId: r.candidates[0].id }; } } } });
  const stale = await f.hub.propose(intent(), { onDecisionError: 'wait' });
  assert.deepEqual([stale.kind, stale.code], ['wait', 'stale-state']);
  assert.equal(f.inbox.pending().length, 0);
  await assert.rejects(f.hub.propose(intent(), { onDecisionError: 'retry' }), { code: 'invalid-options' });
});

const earlyFailures = [
  ['observation', { hub: { state: { async observe() { throw new Error('sensor offline'); } } } }, 'observe'],
  ['candidate preparation', { capability: { async prepare() { throw new Error('adapter bug'); } } }, 'prepare'],
  ['policy', { hub: { policy: { async check() { throw new HubError('policy-down', 'unreachable'); } } } }, 'policy'],
];
for (const [name, setup, phase] of earlyFailures) test(`in wait mode a failure of ${name} still asks the host`, async () => {
  const f = await fixture(setup);
  const r = await f.hub.propose(intent(), { onDecisionError: 'wait' });
  assert.equal(r.kind, 'deliberation'); assert.equal(r.request.subject.phase, phase);
});

test('in wait mode a decider that chooses to ask still asks', async () => {
  const f = await fixture({ hub: { decision: { name: 'asker', async decide() { return { kind: 'deliberate', reason: 'Need a plan' }; } } } });
  const r = await f.hub.propose(intent(), { onDecisionError: 'wait' });
  assert.equal(r.kind, 'deliberation'); assert.equal(r.request.subject.cause, 'decider-asked');
});

test('a host abort is not counted as a decider failure', async () => {
  const entered = deferred(), controller = new AbortController();
  const platform = createPlatform();
  const { runtime } = await boot(platform, { decision: { name: 'slow', async decide() { entered.resolve(); await new Promise(() => {}); } } });
  const run = await runtime.start(spec({ onDecisionError: 'wait' }));
  const pending = runtime.step(run.id, { signal: controller.signal });
  await entered.promise; controller.abort();
  const r = await pending;
  assert.equal(r.outcome, 'waiting'); assert.equal(r.code, 'aborted'); assert.equal(r.run.counters.noProgress, 0);
});

test('consecutive decider failures on a changing state escalate at maxNoProgress, and a success resets the count', async () => {
  const platform = createPlatform(); let fail = true, n = 0;
  const { runtime, inbox, host } = await boot(platform, { decision: { name: 'flaky', async decide(r) {
    if (fail) throw new HubError('jev-http-529', 'overloaded');
    return { kind: 'action', candidateId: r.candidates[0].id };
  } } });
  const run = await runtime.start(spec({ onDecisionError: 'wait', budget: { maxDecisions: 50, maxActions: 10, maxNoProgress: 3, deadlineAt: null } }));
  const change = () => { platform.info = `frame-${++n}`; };         // a real-time host changes state every frame
  for (const expected of [1, 2]) { const r = await runtime.step(run.id); assert.equal(r.run.counters.noProgress, expected); change(); }
  fail = false;
  const recovered = await runtime.step(run.id);
  assert.equal(recovered.outcome, 'waiting'); assert.equal(recovered.run.counters.noProgress, 0); assert.equal(platform.submissions, 1);
  host.complete();                                          // the dispatched action finishes, so the run decides again
  fail = true;
  const runs = [];
  for (let i = 0; i < 4; i++) { change(); runs.push(await runtime.step(run.id)); }
  const escalated = runs.find(r => r.outcome === 'deliberating');
  assert.ok(escalated, 'repeated failures reach the host');
  assert.equal(escalated.run.request.kind, 'no-progress'); assert.equal(inbox.pending().at(-1).kind, 'no-progress');
});

test('the mode persists with the run, and runs saved before v0.3 read as deliberate', async () => {
  const runs = new MemoryRunStore();
  const { runtime } = await boot(createPlatform(), { runs, decision: failing(() => new HubError('jev-http-429', 'rate limited')) });
  await assert.rejects(runtime.start(spec({ onDecisionError: 'sometimes' })), { code: 'invalid-run' });
  const run = await runtime.start(spec({ onDecisionError: 'wait' }));
  assert.equal((await runs.get(run.id)).onDecisionError, 'wait');
  const { onDecisionError, ...legacy } = await runs.get(run.id);
  await runs.replace({ ...legacy, revision: run.revision + 1 }, run.revision);
  const r = await runtime.step(run.id);
  assert.equal(r.outcome, 'deliberating'); assert.equal(r.code, 'jev-http-429');
});
