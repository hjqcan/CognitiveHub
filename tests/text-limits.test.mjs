import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryJournal, PluginHost, TEXT_LIMIT } from '../dist/index.js';
import { fixture, intent } from './fixtures.mjs';
import { boot, createPlatform, spec } from './runtime-host.mjs';
import { record } from './store-conformance.mjs';

// Human-readable text gets its own limit; identifiers keep 512. Jiaogei lost decisions to 600-character candidate
// descriptions and to an objective that listed every event reaction.

const fits = 'x'.repeat(TEXT_LIMIT), over = 'x'.repeat(TEXT_LIMIT + 1);

test('the text limit is 4096 characters and identifiers stay at 512', () => assert.equal(TEXT_LIMIT, 4096));

test('an objective up to the text limit is accepted, one character more is rejected', async () => {
  const f = await fixture();
  assert.equal((await f.hub.propose(intent({ objective: fits }))).kind, 'proposal');
  await assert.rejects(f.hub.propose(intent({ id: 'other', objective: over })), { code: 'invalid-contract' });
  await assert.rejects(f.hub.propose(intent({ id: 'x'.repeat(513) })), { code: 'invalid-contract' });
});

test('capability descriptions follow the text limit', async () => {
  const capability = description => ({ id: 'long.describe@1', description, effect: 'read', async prepare() { return []; },
    validate() {}, async check() { return true; }, async execute() { return { status: 'completed', evidence: null }; },
    async verify() { return { status: 'verified', evidence: null }; } });
  const ok = new PluginHost(); ok.install({ manifest: { apiVersion: 1, id: 'ok', version: '1' }, setup: ctx => ctx.capability(capability(fits)) });
  await ok.start(); assert.equal(ok.status('ok'), 'active');
  const bad = new PluginHost(); bad.install({ manifest: { apiVersion: 1, id: 'bad', version: '1' }, setup: ctx => ctx.capability(capability(over)) });
  await assert.rejects(bad.start(), { code: 'invalid-contract' });
});

test('a 600-character candidate description reaches the decider; an over-long one or a long key fails the turn', async () => {
  const draft = (description, key = 'recover-r01') => ({ key, description, input: { robotId: 'R01' }, resources: ['robot:R01'] });
  let drafts = [draft('Recover R01 by re-queuing the blocked task. '.repeat(14).slice(0, 600))];
  const f = await fixture({ capability: { async prepare() { return drafts; } } });
  assert.equal((await f.hub.propose(intent())).kind, 'proposal');
  drafts = [draft(over)];
  const tooLong = await f.hub.propose(intent({ id: 'task-2' }));
  assert.deepEqual([tooLong.kind, tooLong.request.subject.code, tooLong.request.subject.phase], ['deliberation', 'invalid-contract', 'prepare']);
  drafts = [draft('ok', 'k'.repeat(513))];
  assert.equal((await f.hub.propose(intent({ id: 'task-3' }))).request.subject.code, 'invalid-contract');
});

test('decision reasons follow the text limit', async () => {
  let reason = fits;
  const f = await fixture({ hub: { decision: { name: 'waiter', async decide() { return { kind: 'wait', reason }; } } } });
  assert.equal((await f.hub.propose(intent())).kind, 'wait');
  reason = over;
  assert.equal((await f.hub.propose(intent())).request.subject.code, 'invalid-contract');
});

test('receipt reasons follow the text limit; an over-long one is a malformed receipt, hence unknown', async () => {
  let reason = fits;
  const f = await fixture({ capability: { async execute() { return { status: 'failed', reason, evidence: null }; } } });
  const p = await f.hub.propose(intent());
  assert.equal((await f.hub.execute(p.id, 'op-1', { live: true })).record.status, 'failed');
  reason = over;
  const q = await f.hub.propose(intent({ id: 'task-2' }));
  assert.equal((await f.hub.execute(q.id, 'op-2', { live: true })).record.status, 'unknown');
  const journal = new MemoryJournal([{ ...record(), status: 'failed', revision: 1,
    receipt: { status: 'failed', reason: 'r'.repeat(1000), evidence: null } }]);
  assert.equal(journal.entries().length, 1, 'records written under the new limit load');
});

test('start and revise apply the same intent check as propose', async () => {
  const { runtime, inbox } = await boot(createPlatform());
  await assert.rejects(runtime.start(spec({ intent: { ...spec().intent, objective: over } })), { code: 'invalid-contract' });
  await assert.rejects(runtime.start(spec({ intent: { ...spec().intent, constraints: [42] } })), { code: 'invalid-intent' });
  await assert.rejects(runtime.start(spec({ intent: { ...spec().intent, capabilities: 'sim.advance@1' } })), { code: 'invalid-intent' });
  const run = await runtime.start(spec({ intent: { ...spec().intent, objective: fits } }));
  await assert.rejects(runtime.revise(run.id, { intent: { ...spec().intent, revision: 2, objective: over } }), { code: 'invalid-contract' });
  assert.equal((await runtime.revise(run.id, { intent: { ...spec().intent, revision: 2, objective: 'Reach stage 3 via B' } })).kind, 'applied');
  assert.equal(inbox.pending().length, 0);
});

test('termination reasons follow the text limit', async () => {
  const platform = createPlatform(); platform.stage = 2;           // nothing to do until a fact arrives: the run asks
  const { runtime } = await boot(platform);
  const run = await runtime.start(spec());
  const asked = await runtime.step(run.id);
  const answer = reason => ({ kind: 'terminate', requestId: asked.run.request.id, intentRevision: 1, reason });
  await assert.rejects(runtime.respond(run.id, answer(over)), { code: 'invalid-contract' });
  assert.equal((await runtime.respond(run.id, answer(fits))).run.status, 'stopped');
});
