import test from 'node:test';
import assert from 'node:assert/strict';

// One behavioural contract for every ExecutionJournal and RunStore implementation. Memory and PostgreSQL run the same cases.
let counter = 0;
export const unique = prefix => `${prefix}-${process.pid}-${++counter}`;

export const record = (changes = {}) => {
  const intent = { id: 'intent', revision: 1, scope: ['tenant-a', 'R01'], objective: 'Test', constraints: [], capabilities: ['cap@1'], ...changes.intent };
  const id = changes.id ?? unique('record');
  return {
    id, revision: 0, operationId: id, fingerprint: changes.fingerprint ?? `fp-${id}`, intent,
    observation: { version: 'v1', observedAt: 1, validUntil: 2, facts: null },
    action: { id: 'a', pluginId: 'p', pluginVersion: '1.0.0', activation: 1, capability: 'cap@1', effect: 'write', scope: intent.scope,
      key: 'k', description: 'd', input: null, resources: changes.resources ?? ['robot:R01'] },
    status: 'submitted', receipt: null, evidence: null, createdAt: 1, updatedAt: 1,
  };
};
const settle = (r, status) => ({ ...r, revision: r.revision + 1, status, updatedAt: r.updatedAt + 1,
  receipt: status === 'failed' ? { status: 'failed', reason: 'x', evidence: null } : { status: 'completed', evidence: null } });

export function journalConformance(name, journal) {
  test(`${name}: claim reserves the operation id and its resources atomically`, async () => {
    const j = await journal(); const resource = unique('res');
    const a = record({ resources: [resource] });
    assert.equal((await j.claim(a)).kind, 'claimed');
    assert.deepEqual(await j.get(a.id), a);
    assert.equal((await j.claim(a)).kind, 'existing');
    assert.equal((await j.claim({ ...a, fingerprint: 'other' })).kind, 'conflict');
    const b = record({ resources: [unique('free'), resource] });
    assert.equal((await j.claim(b)).kind, 'conflict');
    assert.equal(await j.get(b.id), undefined);                       // nothing partially written
    assert.equal((await j.claim(record({ resources: [resource], intent: { scope: ['tenant-b', 'R01'] } }))).kind, 'claimed');
    assert.equal((await j.claim(record({ resources: [] }))).kind, 'claimed');   // a read needs no reservation
  });
  test(`${name}: replace is compare-and-swap and a terminal result releases the reservation`, async () => {
    const j = await journal(); const resource = unique('res');
    const a = record({ resources: [resource] }); await j.claim(a);
    await assert.rejects(j.replace({ ...settle(a, 'pending'), revision: 2 }, 0), { code: 'journal-conflict' });
    await assert.rejects(j.replace(settle(a, 'pending'), 5), { code: 'journal-conflict' });
    await assert.rejects(j.replace({ ...settle(a, 'pending'), fingerprint: 'changed' }, 0), { code: 'invalid-record' });
    const pending = settle(a, 'pending'); await j.replace(pending, 0);
    assert.equal((await j.get(a.id)).status, 'pending');
    assert.equal((await j.claim(record({ resources: [resource] }))).kind, 'conflict');   // still reserved
    const verified = { ...pending, revision: 2, status: 'verified', evidence: { done: true } };
    await j.replace(verified, 1);
    assert.deepEqual(await j.get(a.id), verified);
    await assert.rejects(j.replace({ ...verified, revision: 3 }, 2), { code: 'terminal-record' });
    assert.equal((await j.claim(record({ resources: [resource] }))).kind, 'claimed');   // released
  });
  test(`${name}: unsettled lists only open records`, async () => {
    const j = await journal(); const tag = unique('res');
    const open = record({ resources: [`${tag}-1`] }), done = record({ resources: [`${tag}-2`] });
    await j.claim(open); await j.claim(done); await j.replace(settle(done, 'failed'), 0);
    const ids = (await j.unsettled()).map(r => r.id);
    assert.ok(ids.includes(open.id)); assert.ok(!ids.includes(done.id));
  });
  test(`${name}: malformed records are rejected before they reach storage`, async () => {
    const j = await journal();
    await assert.rejects(j.claim({ ...record(), status: 'pending' }), { code: 'invalid-record' });
    await assert.rejects(j.claim({ ...record(), receipt: { status: 'made-up' } }), { code: 'invalid-receipt' });
    const a = record(); await j.claim(a);
    await assert.rejects(j.replace({ ...settle(a, 'pending'), status: 'made-up' }, 0), { code: 'invalid-record' });
  });
}

export const run = (changes = {}) => ({
  id: unique('run'), revision: 0,
  intent: { id: changes.intentId ?? unique('intent'), revision: 1, scope: ['tenant-a'], objective: 'Reach', constraints: [], capabilities: ['cap@1'] },
  guidance: null, budget: { maxDecisions: 5, maxActions: 5, maxNoProgress: 2, deadlineAt: null }, approval: 'automatic', waitMs: 1000,
  status: 'active', operations: [], wait: [], request: null, approved: null, answers: [],
  counters: { decisions: 0, actions: 0, noProgress: 0, signature: null }, progress: null, outcome: null, lease: null, createdAt: 1, updatedAt: 1,
});

export function runStoreConformance(name, store) {
  test(`${name}: create keeps one unsettled run per intent`, async () => {
    const s = await store(); const a = run();
    await s.create(a); assert.deepEqual(await s.get(a.id), a);
    await assert.rejects(s.create(a), { code: 'run-exists' });
    await assert.rejects(s.create(run({ intentId: a.intent.id })), { code: 'run-exists' });
    await s.replace({ ...a, revision: 1, status: 'completed' }, 0);
    await s.create(run({ intentId: a.intent.id }));   // allowed once the earlier run ended
  });
  test(`${name}: replace is compare-and-swap and finished runs are immutable`, async () => {
    const s = await store(); const a = run(); await s.create(a);
    await assert.rejects(s.replace({ ...a, revision: 2 }, 0), { code: 'run-conflict' });
    await assert.rejects(s.replace({ ...a, revision: 1 }, 3), { code: 'run-conflict' });
    await assert.rejects(s.replace({ ...run(), revision: 1 }, 0), { code: 'run-conflict' });
    await s.replace({ ...a, revision: 1, status: 'waiting', wait: [{ kind: 'time', at: 5 }] }, 0);
    assert.equal((await s.get(a.id)).status, 'waiting');
    await s.replace({ ...a, revision: 2, status: 'stopped' }, 1);
    await assert.rejects(s.replace({ ...a, revision: 3, status: 'active' }, 2), { code: 'run-terminal' });
  });
  test(`${name}: events are deduplicated per run and unsettled lists open runs`, async () => {
    const s = await store(); const a = run(), b = run(); await s.create(a); await s.create(b);
    assert.equal(await s.markEvent(a.id, 'e1'), true); assert.equal(await s.markEvent(a.id, 'e1'), false);
    assert.equal(await s.markEvent(b.id, 'e1'), true);
    await s.replace({ ...b, revision: 1, status: 'failed' }, 0);
    const ids = (await s.unsettled()).map(r => r.id);
    assert.ok(ids.includes(a.id)); assert.ok(!ids.includes(b.id));
  });
}

export const decision = (changes = {}) => ({
  id: unique('decision'), intentId: changes.intentId ?? 'intent', intentRevision: 1, scope: ['tenant-a'], tags: changes.tags ?? {},
  observationVersion: 'v1', guidanceVersion: null, notRequested: [],
  considered: [{ pluginId: 'p', pluginVersion: '1.0.0', capability: 'cap@1', drafts: 1 }], excluded: [],
  request: null, provider: 'fixture', decision: { kind: 'wait', reason: 'r' }, outcome: 'wait', code: null,
  proposalId: null, requestId: null, recordId: null, createdAt: changes.createdAt ?? 1,
});

export function decisionStoreConformance(name, store) {
  test(`${name}: append is unique by id and link attaches the execution record`, async () => {
    const s = await store(); const d = decision({ intentId: unique('intent') });
    await s.append(d);
    assert.deepEqual((await s.list({ intentId: d.intentId })).find(x => x.id === d.id), d);
    await assert.rejects(s.append(d), { code: 'duplicate-decision' });
    await s.link(d.id, 'record-1');
    assert.equal((await s.list({ intentId: d.intentId })).find(x => x.id === d.id).recordId, 'record-1');
    await assert.rejects(s.link('missing', 'record-1'), { code: 'unknown-decision' });
  });
  test(`${name}: list filters by intent and tag, in time order, with a limit`, async () => {
    const s = await store(); const intentId = unique('intent'), runId = unique('run');
    const a = decision({ intentId, tags: { runId }, createdAt: 3 });
    const b = decision({ intentId, tags: { runId: 'other' }, createdAt: 1 });
    const c = decision({ intentId, createdAt: 2 });
    for (const d of [a, b, c]) await s.append(d);
    assert.deepEqual((await s.list({ intentId })).map(x => x.id), [b.id, c.id, a.id]);
    assert.deepEqual((await s.list({ intentId, tag: { key: 'runId', value: runId } })).map(x => x.id), [a.id]);
    assert.deepEqual((await s.list({ intentId, limit: 2 })).map(x => x.id), [b.id, c.id]);
    assert.equal((await s.list({ intentId: unique('none') })).length, 0);
  });
}
