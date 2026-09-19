import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDecisionStore } from '../dist/index.js';
import { fixture, intent } from './fixtures.mjs';

test('a decision record explains what was considered, excluded, chosen and executed', async () => {
  const decisions = new MemoryDecisionStore();
  const f = await fixture({
    hub: { decisions, policy: { check: async ({ action }) =>
      ({ allowed: action.key !== 'b', version: 'p1', reason: action.key === 'b' ? 'b is off limits' : 'ok' }) } },
    capability: { prepare: async () => ['a', 'b'].map(key => ({ key, description: key, input: { robotId: 'R01' }, resources: ['robot:R01'] })) },
  });
  const p = await f.hub.propose(intent(), { tags: { runId: 'r1' } });
  assert.equal(p.kind, 'proposal');
  const [record] = decisions.entries();
  assert.equal(record.outcome, 'proposal'); assert.equal(record.proposalId, p.id); assert.equal(record.recordId, null); assert.equal(record.code, null);
  assert.deepEqual(record.tags, { runId: 'r1' }); assert.equal(record.observationVersion, 'v1'); assert.equal(record.provider, 'fixture');
  assert.deepEqual(record.considered, [{ pluginId: 'robot', pluginVersion: '1.0.0', capability: 'robot.recover@1', drafts: 2 }]);
  assert.deepEqual(record.excluded.map(e => [e.reason, e.policyVersion]), [['b is off limits', 'p1']]);
  assert.equal(record.request.candidates.length, 1); assert.equal(record.decision.kind, 'action'); assert.equal(record.decision.candidateId, p.action.id);
  const r = await f.hub.execute(p.id, 'op', { live: true });
  assert.equal(decisions.entries()[0].recordId, r.record.id);
  assert.ok(f.events.entries().some(e => e.type === 'decision.recorded'));
  assert.equal(f.hub.observerErrors, 0);
});

test('turns without candidates or with a failing decider are recorded with their reason', async () => {
  const none = new MemoryDecisionStore();
  const f = await fixture({ hub: { decisions: none } });
  const asked = await f.hub.propose(intent({ capabilities: [] }));
  const [skipped] = none.entries();
  assert.equal(skipped.outcome, 'deliberation'); assert.equal(skipped.code, null); assert.equal(skipped.requestId, asked.request.id);
  assert.deepEqual(skipped.notRequested, ['robot.recover@1']); assert.deepEqual(skipped.considered, []); assert.equal(skipped.request, null);
  const failed = new MemoryDecisionStore();
  const g = await fixture({ hub: { decisions: failed, decision: { name: 'offline', decide: async () => { throw new Error('vendor down'); } } } });
  assert.equal((await g.hub.propose(intent())).kind, 'deliberation');
  const [failure] = failed.entries();
  assert.equal(failure.outcome, 'deliberation'); assert.equal(failure.code, 'decision-unavailable'); assert.equal(failure.decision, null);
  assert.equal(failure.request.candidates.length, 1); assert.equal(failure.provider, 'offline');
});

test('a failing decision store never changes the outcome and is counted as an observer error', async () => {
  const f = await fixture({ hub: { decisions: { append: async () => { throw new Error('audit db down'); }, link: async () => {}, list: async () => [] } } });
  const p = await f.hub.propose(intent()); assert.equal(p.kind, 'proposal');
  assert.ok(f.hub.observerErrors > 0);
  assert.ok(f.events.entries().some(e => e.type === 'decision.record.failed'));
  assert.equal((await f.hub.execute(p.id, 'op', { live: true })).record.status, 'verified');
});

test('tags are validated and the audit is off unless a store is configured', async () => {
  const f = await fixture();
  await assert.rejects(f.hub.propose(intent(), { tags: { runId: 1 } }), { code: 'invalid-tags' });
  assert.equal((await f.hub.propose(intent(), { tags: { runId: 'r1' } })).kind, 'proposal');
  assert.ok(!f.events.entries().some(e => e.type === 'decision.recorded'));
});
