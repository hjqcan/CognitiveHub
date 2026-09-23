import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionLimiter, HumanInbox, IntentRuntime, limitDecider, PluginHost } from '../dist/index.js';
import { deferred, tick } from './fixtures.mjs';

// What every multi-run host wrote by hand: a shared decider with a concurrency limit and a call budget, a bounded pass
// over the due runs, and stopping every plugin in dependency order.

const request = { intent: { id: 'i', objective: 'o', constraints: [] }, observation: { facts: null }, candidates: [{ id: 'a' }] };
const signal = () => new AbortController().signal;

/** A decider whose calls wait until the test releases them, recording peak concurrency. */
function gated(name = 'inner') {
  const calls = [];
  let active = 0, peak = 0;
  return { calls, get peak() { return peak; }, get active() { return active; },
    decider: { name, async decide(r) {
      active++; peak = Math.max(peak, active);
      const gate = deferred(); calls.push({ request: r, gate });
      try { return await gate.promise; } finally { active--; }
    } } };
}

test('the limiter never lets more calls in flight than its concurrency, and hands slots over in order', async () => {
  const inner = gated(), limiter = limitDecider(inner.decider, { concurrency: 2 });
  const order = [];
  const all = Array.from({ length: 5 }, (_, i) => limiter.decide({ ...request, tag: i }, signal())
    .then(d => order.push(d.candidateId)));
  await tick();
  assert.equal(inner.calls.length, 2); assert.equal(limiter.queued, 3); assert.equal(limiter.inFlight, 2);
  for (let i = 0; i < 5; i++) {
    await tick();
    inner.calls[i].gate.resolve({ kind: 'action', candidateId: `c${inner.calls[i].request.tag}` });
    await tick(); await tick();
    assert.ok(inner.active <= 2);
  }
  await Promise.all(all);
  assert.deepEqual(order, ['c0', 'c1', 'c2', 'c3', 'c4']); assert.equal(inner.peak, 2);
  assert.equal(limiter.inFlight, 0); assert.equal(limiter.used, 5);
});

test('a caller that stops waiting keeps its slot until the vendor call really ends', async () => {
  const inner = gated(), limiter = limitDecider(inner.decider, { concurrency: 1 });
  const controller = new AbortController();
  const first = limiter.decide(request, controller.signal).catch(e => e);
  await tick();
  const second = limiter.decide(request, signal());
  await tick();
  assert.equal(inner.calls.length, 1, 'the second call queues behind the first');
  controller.abort(new Error('caller gave up'));             // the inner call ignores the signal and keeps running
  await tick();
  assert.equal(inner.calls.length, 1, 'no slot is freed while the abandoned call still runs'); assert.equal(inner.peak, 1);
  inner.calls[0].gate.resolve({ kind: 'wait', reason: 'late' });
  await first; await tick(); await tick();
  assert.equal(inner.calls.length, 2);
  inner.calls[1].gate.resolve({ kind: 'wait', reason: 'second' });
  assert.equal((await second).reason, 'second');
});

test('a caller aborted while queued leaves the queue and spends no budget', async () => {
  const inner = gated(), limiter = limitDecider(inner.decider, { concurrency: 1, maxCalls: 5 });
  const first = limiter.decide(request, signal());
  const controller = new AbortController();
  const queued = limiter.decide(request, controller.signal);
  await tick(); assert.equal(limiter.queued, 1);
  controller.abort(new Error('host cancelled'));
  await assert.rejects(queued, /host cancelled/);
  assert.equal(limiter.queued, 0); assert.equal(limiter.used, 1);
  inner.calls[0].gate.resolve({ kind: 'wait', reason: 'done' }); await first;
  assert.equal(limiter.inFlight, 0);
});

test('the budget is counted at dispatch, failures count, exhaustion asks the host, and raising it resumes', async () => {
  let calls = 0;
  const limiter = new DecisionLimiter({ name: 'jev-fixture', async decide() {
    calls++; if (calls === 2) throw new Error('vendor down');
    return { kind: 'action', candidateId: 'a' };
  } }, { concurrency: 1, maxCalls: 2, name: 'shared-budget' });
  const ok = await limiter.decide(request, signal());
  assert.equal(ok.provider, 'jev-fixture', 'decisions without a provider are stamped with the wrapped decider');
  await assert.rejects(limiter.decide(request, signal()), /vendor down/);
  assert.equal(limiter.used, 2);
  const spent = await limiter.decide(request, signal());
  assert.deepEqual([spent.kind, spent.provider, spent.metadata.code], ['deliberate', 'shared-budget', 'decision-budget']);
  assert.equal(calls, 2, 'no call once the budget is spent');
  limiter.maxCalls = 3;
  assert.equal((await limiter.decide(request, signal())).kind, 'action'); assert.equal(calls, 3);
  const own = new DecisionLimiter({ name: 'router', async decide() { return { kind: 'wait', reason: 'r', provider: 'rules' }; } }, { concurrency: 1 });
  assert.equal((await own.decide(request, signal())).provider, 'rules');
  for (const options of [{ concurrency: 0 }, { concurrency: 1, maxCalls: -1 }, { concurrency: 1.5 }])
    assert.throws(() => new DecisionLimiter({ name: 'x', async decide() {} }, options), { code: 'invalid-options' });
});

/** Several independent runs over one runtime: each advances its own counter to `goal`, one action per step. */
async function fleet(n, { goal = 3, decider, broken = new Set() } = {}) {
  const counters = new Map();
  const plugins = new PluginHost();
  plugins.install({ manifest: { apiVersion: 1, id: 'fleet', version: '1.0.0' }, setup(ctx) {
    ctx.capability({ id: 'fleet.advance@1', description: 'Advance this worker', effect: 'write',
      async prepare({ intent }) { return [{ key: 'advance', description: 'Advance', input: { worker: intent.id }, resources: [`worker:${intent.id}`] }]; },
      validate() {}, async check() { return true; },
      async execute({ action }) { counters.set(action.input.worker, (counters.get(action.input.worker) ?? 0) + 1); return { status: 'completed', evidence: null }; },
      async verify() { return { status: 'verified', evidence: null }; } });
  } }, ['fleet']);
  await plugins.start();
  const clock = { now: 1_000_000 };
  const runtime = new IntentRuntime({ plugins, owner: 'fleet-worker', now: () => clock.now, deliberation: new HumanInbox(),
    state: { async observe(intent) {
      if (broken.has(intent.id)) throw new Error('this worker\'s sensor is offline');
      const v = counters.get(intent.id) ?? 0;
      return { version: `${intent.id}:${v}`, observedAt: clock.now, validUntil: clock.now + 60000, facts: { count: v } };
    } },
    decision: decider ?? { name: 'first', async decide(r) { return { kind: 'action', candidateId: r.candidates[0].id }; } },
    policy: { async check() { return { allowed: true, version: 'p', reason: 'fleet' }; } },
    goal: { async evaluate({ intent }) { return { status: (counters.get(intent.id) ?? 0) >= goal ? 'satisfied' : 'unsatisfied', evidence: null }; } } });
  const runs = [];
  for (let i = 0; i < n; i++) {
    runs.push(await runtime.start({ approval: 'automatic', budget: { maxDecisions: 50, maxActions: 50, maxNoProgress: 5, deadlineAt: null },
      intent: { id: `w${i}`, revision: 1, scope: ['fleet'], objective: 'Advance this worker', constraints: [], capabilities: ['fleet.advance@1'] } }));
    clock.now += 1;
  }
  return { runtime, runs, counters, clock, plugins };
}

test('stepDue steps due runs earliest first within its concurrency and limit, without starving anyone', async () => {
  let active = 0, peak = 0;
  const decider = { name: 'slow', async decide(r) { active++; peak = Math.max(peak, active); await tick(); active--; return { kind: 'action', candidateId: r.candidates[0].id }; } };
  const f = await fleet(6, { decider, goal: 100 });
  const first = await f.runtime.stepDue({ concurrency: 2, limit: 4 });
  assert.deepEqual(first.map(d => d.runId), f.runs.slice(0, 4).map(r => r.id), 'oldest wake time first');
  assert.equal(peak, 2);
  f.clock.now += 10;
  const second = await f.runtime.stepDue({ concurrency: 3, limit: 4 });
  assert.deepEqual(second.slice(0, 2).map(d => d.runId), f.runs.slice(4).map(r => r.id), 'runs left out last time go first now');
  assert.ok(second.every(d => d.result.outcome === 'executed'));
  await assert.rejects(f.runtime.stepDue({ concurrency: 0 }), { code: 'invalid-options' });
});

test('stepDue reports a failing run in its entry and keeps stepping the others', async () => {
  const f = await fleet(3, { broken: new Set(['w1']) });
  const results = await f.runtime.stepDue({ concurrency: 2 });
  assert.equal(results.length, 3);
  const failed = results.find(d => d.runId === f.runs[1].id);
  assert.match(String(failed.error), /sensor is offline/);
  assert.ok(results.filter(d => d.runId !== f.runs[1].id).every(d => d.result.outcome === 'executed'));
});

test('an aborted signal stops stepDue from starting more steps', async () => {
  const controller = new AbortController(); let decided = 0;
  const decider = { name: 'counting', async decide(r) { decided++; if (decided === 1) controller.abort(); return { kind: 'action', candidateId: r.candidates[0].id }; } };
  const f = await fleet(4, { decider });
  const results = await f.runtime.stepDue({ concurrency: 1, signal: controller.signal });
  assert.equal(results.length, 1); assert.equal(decided, 1);
});

test('eight runs share one budgeted decider at concurrency two until every goal is met', async () => {
  const inner = { name: 'model', active: 0, peak: 0, async decide(r) {
    this.active++; this.peak = Math.max(this.peak, this.active); await tick(); this.active--;
    return { kind: 'action', candidateId: r.candidates[0].id };
  } };
  const limiter = limitDecider(inner, { concurrency: 2, maxCalls: 24 });
  const f = await fleet(8, { decider: limiter, goal: 3 });
  for (let round = 0; round < 10; round++) { await f.runtime.stepDue({ concurrency: 8 }); f.clock.now += 100; }
  assert.ok(inner.peak <= 2, `peak ${inner.peak}`); assert.equal(limiter.used, 24);
  assert.deepEqual([...f.counters.values()], Array(8).fill(3));
  for (const run of f.runs) assert.equal((await f.runtime.get(run.id)).status, 'completed');
});

const plugin = (id, extra = {}, setup = () => {}) => ({ manifest: { apiVersion: 1, id, version: '1.0.0', ...extra }, setup });

test('stopAll stops dependents before the services they require, each round together', async () => {
  const host = new PluginHost(), order = [];
  host.install(plugin('ship-world', { provides: ['ship.world.v1'] }, ctx => { ctx.provide('ship.world.v1', {}); ctx.onDispose(() => order.push('ship-world')); }));
  for (const id of ['engineering', 'navigation', 'rescue', 'communications'])
    host.install(plugin(id, { requires: ['ship.world.v1'] }, ctx => { ctx.service('ship.world.v1'); ctx.onDispose(() => order.push(id)); }));
  host.install(plugin('decider', { provides: ['decision.v1'] }, ctx => ctx.provide('decision.v1', {})));
  await host.start();
  const result = await host.stopAll();
  assert.equal(order.at(-1), 'ship-world'); assert.deepEqual(result.failed, []); assert.deepEqual(result.skipped, []);
  assert.equal(result.stopped.length, 6); assert.equal(result.stopped.at(-1), 'ship-world');
  for (const id of result.stopped) assert.equal(host.status(id), 'stopped');
});

test('stopAll reports a plugin whose drain was aborted and skips the services it still holds', async () => {
  const host = new PluginHost();
  host.install(plugin('world', { provides: ['world.v1'] }, ctx => ctx.provide('world.v1', {})));
  host.install(plugin('busy', { requires: ['world.v1'] }, ctx => {
    ctx.service('world.v1');
    ctx.capability({ id: 'busy.act@1', description: 'Act', effect: 'read', async prepare() { return []; }, validate() {},
      async check() { return true; }, async execute() { return { status: 'completed', evidence: null }; },
      async verify() { return { status: 'verified', evidence: null }; } });
  }));
  host.install(plugin('idle'));
  await host.start();
  const lease = host.acquire('busy', 'busy.act@1', host.list(['t'])[0].activation, ['t']);
  const controller = new AbortController();
  const pending = host.stopAll({ signal: controller.signal });
  await tick(); controller.abort();
  const result = await pending;
  assert.deepEqual(result.failed, [{ id: 'busy', code: 'drain-aborted' }]);
  assert.deepEqual(result.skipped, ['world']); assert.deepEqual(result.stopped, ['idle']);
  assert.equal(host.status('busy'), 'draining'); assert.equal(host.status('world'), 'active');
  lease.release();
  const rest = await host.stopAll();
  assert.deepEqual(rest.stopped, ['busy', 'world']);
});
