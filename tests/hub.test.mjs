import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, intent, deferred, tick } from './fixtures.mjs';

test('preview is the default and performs no execution or journal claim', async () => {
  const f = await fixture(), p = await f.hub.propose(intent()); assert.equal(p.kind, 'proposal');
  assert.equal((await f.hub.execute(p.id, 'preview')).kind, 'dry-run');
  assert.equal(f.control.calls, 0); assert.equal(f.journal.entries().length, 0);
});
test('explicit execution verifies host evidence and retains model-independent trace', async () => {
  const f = await fixture(), p = await f.hub.propose(intent());
  const r = await f.hub.execute(p.id, 'op', { live: true });
  assert.equal(r.record.status, 'verified'); assert.equal(f.control.calls, 1); assert.equal(f.control.verifyCalls, 1);
  assert.deepEqual(r.record.evidence, { taskState: 'done' });
  assert.ok(f.events.entries().some(e => e.type === 'execution.updated'));
});
test('a completed receipt without successful verification is only pending', async () => {
  const f = await fixture({ capability: { verify: async () => { throw new Error('read unavailable'); } } });
  const p = await f.hub.propose(intent()), r = await f.hub.execute(p.id, 'op', { live: true });
  assert.equal(r.record.status, 'pending'); assert.equal(r.record.receipt.status, 'completed');
});
test('operation retries return the existing record without repeating a side effect', async () => {
  const f = await fixture(), p = await f.hub.propose(intent());
  const first = await f.hub.execute(p.id, 'stable-op', { live: true });
  const retry = await f.hub.execute(p.id, 'stable-op', { live: true });
  assert.equal(retry.duplicate, true); assert.equal(retry.record.id, first.record.id); assert.equal(f.control.calls, 1);
});
test('one proposal cannot authorize multiple operations', async () => {
  const f = await fixture(), p = await f.hub.propose(intent());
  await f.hub.execute(p.id, 'first', { live: true });
  assert.equal((await f.hub.execute(p.id, 'second', { live: true })).kind, 'rejected'); assert.equal(f.control.calls, 1);
});
test('reusing an operation ID with changed intent/action is rejected', async () => {
  const f = await fixture(); const a = await f.hub.propose(intent());
  await f.hub.execute(a.id, 'op', { live: true });
  const b = await f.hub.propose(intent({ revision: 2 }));
  assert.equal((await f.hub.execute(b.id, 'op', { live: true })).kind, 'rejected'); assert.equal(f.control.calls, 1);
});
test('changed observations invalidate a decision before it reaches the executor', async () => {
  const f = await fixture(), p = await f.hub.propose(intent()); f.control.version = 'v2';
  assert.equal((await f.hub.execute(p.id, 'op', { live: true })).kind, 'rejected'); assert.equal(f.control.calls, 0);
});
test('proposal expiry invalidates both live dispatch and preview', async () => {
  const f = await fixture(), p = await f.hub.propose(intent()); f.control.now += 4000;
  assert.equal((await f.hub.execute(p.id, 'op', { live: true })).kind, 'rejected'); assert.equal(f.control.calls, 0);
});
test('revocation and policy version changes cannot be overridden by model choice', async () => {
  for (const mutate of [c => { c.allow = false; }, c => { c.policyVersion = 'p2'; }]) {
    const f = await fixture(), p = await f.hub.propose(intent()); mutate(f.control);
    assert.equal((await f.hub.execute(p.id, 'op', { live: true })).kind, 'rejected'); assert.equal(f.control.calls, 0);
  }
});
test('authorization is checked again after asynchronous preconditions', async () => {
  let f; f = await fixture({ capability: { check: async () => { f.control.allow = false; return true; } } });
  const p = await f.hub.propose(intent());
  assert.equal((await f.hub.execute(p.id, 'op', { live: true })).kind, 'rejected'); assert.equal(f.control.calls, 0);
});
test('no suitable/authorized capability requests deliberation, without calling the model', async () => {
  const f = await fixture({ hub: { decision: { name: 'never', decide: async () => { throw new Error('should not call'); } } } });
  const result = await f.hub.propose(intent({ capabilities: [] }));
  assert.equal(result.kind, 'deliberation'); assert.match(result.request.reason, /No authorized/);
  assert.equal(f.inbox.pending().length, 1); assert.equal(f.control.calls, 0);
});
test('capabilities cannot cross a tenant or robot scope', async () => {
  const f = await fixture();
  assert.equal((await f.hub.propose(intent({ scope: ['tenant-a','R02'] }))).kind, 'deliberation');
  assert.equal((await f.hub.propose(intent({ scope: ['tenant-b','R01'] }))).kind, 'deliberation');
});
test('a model-invented candidate is rejected and escalated', async () => {
  const f = await fixture({ hub: { decision: { name: 'bad', decide: async () => ({ kind: 'action', candidateId: 'shell.delete-all' }) } } });
  assert.equal((await f.hub.propose(intent())).kind, 'deliberation'); assert.equal(f.control.calls, 0);
});
test('invalid capability parameters never reach the decision provider', async () => {
  const f = await fixture({ capability: { prepare: async () => [{ key: 'bad', description: 'Bad', input: { robotId: 'OTHER' }, resources: ['robot:R01'] }] } });
  assert.equal((await f.hub.propose(intent())).kind, 'deliberation');
});
test('duplicate candidate keys and unreserved writes fail closed', async () => {
  for (const drafts of [
    [{ key: 'x', description: 'x', input: { robotId: 'R01' }, resources: [] }],
    Array.from({ length: 2 }, () => ({ key: 'x', description: 'x', input: { robotId: 'R01' }, resources: ['robot:R01'] })),
  ]) {
    const f = await fixture({ capability: { prepare: async () => drafts } });
    assert.equal((await f.hub.propose(intent())).kind, 'deliberation');
  }
});
test('model failures request human deliberation rather than substituting a different action', async () => {
  const f = await fixture({ hub: { decision: { name: 'offline', decide: async () => { throw new Error('secret vendor response'); } } } });
  const r = await f.hub.propose(intent()); assert.equal(r.kind, 'deliberation');
  assert.doesNotMatch(r.request.reason, /secret/); assert.equal(f.control.calls, 0);
});
test('single-flight rejects overlapping decisions for one intent', async () => {
  const gate = deferred(), entered = deferred();
  const f = await fixture({ hub: { decision: { name: 'slow', decide: async request => { entered.resolve(); await gate.promise;
    return { kind: 'action', candidateId: request.candidates[0].id }; } } } });
  const first = f.hub.propose(intent()); await entered.promise;
  assert.equal((await f.hub.propose(intent())).kind, 'wait'); gate.resolve(); assert.equal((await first).kind, 'proposal');
});
test('a deadline rejects late decisions and keeps the plugin leased until callback settlement', async () => {
  const gate = deferred(), entered = deferred();
  const f = await fixture({ hub: { decisionTimeoutMs: 10, decision: { name: 'slow', decide: async request => {
    entered.resolve(); await gate.promise; return { kind: 'action', candidateId: request.candidates[0].id }; } } } });
  const first = f.hub.propose(intent()); await entered.promise;
  assert.equal((await first).kind, 'deliberation');
  assert.equal((await f.hub.propose(intent())).kind, 'wait');
  let drained = false; const stop = f.plugins.stop('robot').then(() => { drained = true; });
  await tick(); assert.equal(drained, false); gate.resolve(); await stop;
  assert.equal(f.control.calls, 0);
});
test('pre-aborted decisions never create proposals', async () => {
  const f = await fixture(), controller = new AbortController(); controller.abort();
  assert.equal((await f.hub.propose(intent(), { signal: controller.signal })).kind, 'wait');
  assert.equal((await f.hub.propose(intent())).kind, 'proposal');
});
test('unknown executor outcomes keep resources locked and are queried, not replayed', async () => {
  let calls = 0;
  const f = await fixture({ capability: {
    execute: async () => { calls++; throw new Error('reply lost after submit'); },
    reconcile: async () => ({ status: 'completed', evidence: { task: 'found-by-idempotency-key' } }),
  } });
  const p = await f.hub.propose(intent()), first = await f.hub.execute(p.id, 'op', { live: true });
  assert.equal(first.record.status, 'unknown');
  assert.equal((await f.hub.execute(p.id, 'op', { live: true })).duplicate, true);
  const other = await f.hub.propose(intent({ id: 'other-task' }));
  assert.equal((await f.hub.execute(other.id, 'other-op', { live: true })).kind, 'rejected');
  assert.equal((await f.hub.reconcile(first.record.id)).record.status, 'verified'); assert.equal(calls, 1);
  assert.equal((await f.hub.execute(other.id, 'other-op', { live: true })).record.status, 'unknown');
});
test('malformed executor responses become unknown, never confirmed failure', async () => {
  const f = await fixture({ capability: { execute: async () => ({ status: 'made-up' }) } });
  const p = await f.hub.propose(intent()); assert.equal((await f.hub.execute(p.id, 'op', { live: true })).record.status, 'unknown');
});
test('accepted means pending; only a later queried and verified result completes the action', async () => {
  const f = await fixture({ capability: { execute: async () => ({ status: 'accepted', handle: 'H1', evidence: null }),
    reconcile: async () => ({ status: 'completed', evidence: { exists: true } }) } });
  const p = await f.hub.propose(intent()), r = await f.hub.execute(p.id, 'op', { live: true });
  assert.equal(r.record.status, 'pending'); assert.equal(f.control.verifyCalls, 0);
  assert.equal((await f.hub.reconcile(r.record.id)).record.status, 'verified'); assert.equal(f.control.verifyCalls, 1);
});
test('a timed-out dispatch is not converted to success when its late reply arrives', async () => {
  const gate = deferred(); const f = await fixture({ hub: { executionTimeoutMs: 10 },
    capability: { execute: async () => { await gate.promise; return { status: 'completed', evidence: null }; } } });
  const p = await f.hub.propose(intent()), r = await f.hub.execute(p.id, 'op', { live: true });
  assert.equal(r.record.status, 'unknown'); gate.resolve(); await tick();
  assert.equal((await f.journal.get(r.record.id)).status, 'unknown');
});
test('immutable proposal and journal objects cannot be modified by callers', async () => {
  const f = await fixture(), p = await f.hub.propose(intent());
  assert.throws(() => { p.action.input.robotId = 'OTHER'; }, TypeError);
  const r = await f.hub.execute(p.id, 'op', { live: true });
  assert.throws(() => { r.record.status = 'submitted'; }, TypeError);
});
test('observer failures do not change execution outcomes', async () => {
  const f = await fixture({ hub: { events: { emit() { throw new Error('observer offline'); } } } });
  const p = await f.hub.propose(intent());
  assert.equal((await f.hub.execute(p.id, 'op', { live: true })).record.status, 'verified');
  assert.ok(f.hub.observerErrors > 0);
});
test('journal failure after dispatch is surfaced and does not release the task lease', async () => {
  const f = await fixture(); f.journal.replace = async () => { throw new Error('storage down'); };
  const p = await f.hub.propose(intent());
  await assert.rejects(f.hub.execute(p.id, 'op', { live: true }), /storage down/);
  assert.equal(f.control.calls, 1); assert.equal(f.journal.entries()[0].status, 'submitted');
  assert.equal((await f.hub.execute(p.id, 'op', { live: true })).duplicate, true);
});
test('a human request is not itself execution approval', async () => {
  const f = await fixture({ hub: { decision: { name: 'ask', decide: async () => ({ kind: 'deliberate', reason: 'Need a new plan' }) } } });
  const r = await f.hub.propose(intent()); assert.equal(r.kind, 'deliberation');
  assert.equal(f.inbox.acknowledge(r.request.id), true); assert.equal(f.control.calls, 0);
  assert.equal((await f.hub.execute(r.request.id, 'op', { live: true })).kind, 'rejected');
});
test('non-finite and cyclic host data are rejected before inference', async () => {
  const bad = { a: NaN }; const cycle = {}; cycle.self = cycle;
  for (const facts of [bad, cycle]) {
    const f = await fixture({ hub: { state: { observe: async () => ({ version: 'v1', observedAt: 1000, validUntil: 2000, facts }) } } });
    assert.equal((await f.hub.propose(intent())).kind, 'deliberation');
  }
});

test('concurrent dispatches from the same proposal cannot both execute', async () => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture({ capability: { execute: async () => { calls++; entered.resolve(); await release.promise;
    return { status: 'completed', evidence: null }; } } });
  const p = await f.hub.propose(intent()), first = f.hub.execute(p.id, 'first', { live: true });
  await entered.promise;
  assert.equal((await f.hub.execute(p.id, 'second', { live: true })).kind, 'rejected');
  release.resolve(); await first; assert.equal(calls, 1);
});
test('a timed-out preflight does not dispose the plugin while its check still runs', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ hub: { executionTimeoutMs: 10 }, capability: { check: async () => {
    entered.resolve(); await release.promise; return true;
  } } });
  const p = await f.hub.propose(intent()), attempt = f.hub.execute(p.id, 'op', { live: true });
  await entered.promise; assert.equal((await attempt).kind, 'rejected');
  let stopped = false; const stop = f.plugins.stop('robot').then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false); release.resolve(); await stop; assert.equal(f.control.calls, 0);
});
test('missing observation facts and malformed non-action decisions are rejected', async () => {
  const f = await fixture({ hub: { state: { observe: async () => ({ version: 'v1', observedAt: 1000, validUntil: 2000 }) } } });
  assert.equal((await f.hub.propose(intent())).kind, 'deliberation');
  const g = await fixture({ hub: { decision: { name: 'bad', decide: async () => ({ kind: 'wait' }) } } });
  assert.equal((await g.hub.propose(intent())).kind, 'deliberation');
});
test('a failed human delivery is surfaced once rather than issuing duplicate requests', async () => {
  let calls = 0;
  const f = await fixture({ hub: { deliberation: { request: async () => { calls++; throw new Error('inbox unavailable'); } } } });
  await assert.rejects(f.hub.propose(intent({ capabilities: [] })), /inbox unavailable/);
  assert.equal(calls, 1);
});
