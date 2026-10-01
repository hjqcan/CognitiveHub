import test from 'node:test';
import assert from 'node:assert/strict';
import { createFourLaneAdvisor, createEnvelope, digest } from '../examples/goodmemory-four-lane/advisor.mjs';
import { admissionComparator, conflictComparator, deletionEnvelope, orderPlanReranker } from '../examples/goodmemory-four-lane/adapters.mjs';

const scope = { tenantId: null, userId: 'fixture', workspaceId: 'lab', agentId: null, sessionId: null };
const binding = digest({ target: 'fixture', version: 1 });
const envelope = (lane = 'admission') => createEnvelope({ lane, scope, binding, facts: { candidate: 'synthetic source' },
  choices: lane === 'admission' ? ['admit', 'skip', 'abstain'] : lane === 'update' ? ['keep', 'supersede', 'abstain'] : lane === 'delete' ? ['retain', 'propose_delete', 'abstain'] : ['identity', 'alternative', 'abstain'] });
const provider = choice => ({ name: 'offline-fixture', async decide(request) {
  return { kind: 'action', candidateId: request.candidates.find(candidate => candidate.key === choice)?.id ?? 'unknown', metadata: { confidence: 1 } };
} });

test('disabled does not inspect inputs, invoke decider or read binding', async () => {
  let calls = 0;
  const advisor = createFourLaneAdvisor({ decision: { name: 'disabled', decide() { calls++; throw new Error('forbidden'); } } });
  const result = await advisor.evaluate(null, { readCurrentBinding() { calls++; throw new Error('forbidden'); } });
  assert.equal(result.code, 'disabled'); assert.equal(calls, 0); assert.equal(result.authorized, false);
});

test('each finite lane runs real advisory runtime with no dispatch or journal', async () => {
  for (const [lane, choice] of [['admission', 'admit'], ['update', 'supersede'], ['delete', 'propose_delete'], ['rerank', 'alternative']]) {
    const advisor = createFourLaneAdvisor({ enabled: true, decision: provider(choice) });
    const result = await advisor.evaluate(envelope(lane), { readCurrentBinding: async () => binding });
    assert.equal(result.choice, choice); assert.equal(result.code, 'advised');
    assert.deepEqual([result.dispatched, result.journalEntries, result.authorized, result.memoryMutated], [0, 0, false, false]);
    assert.equal(Object.isFrozen(result), true);
  }
});

test('strict envelope refuses labels, omitted scope and invalid choices', () => {
  const valid = envelope();
  assert.throws(() => createEnvelope({ ...valid, baseline: 'admit' }));
  assert.throws(() => createEnvelope({ lane: 'delete', scope: { userId: 'fixture' }, binding, facts: {}, choices: ['propose_delete', 'abstain'] }));
  assert.throws(() => createEnvelope({ lane: 'delete', scope, binding, facts: {}, choices: ['delete_all', 'abstain'] }));
  assert.throws(() => createEnvelope({ lane: 'rerank', scope, binding, facts: {}, choices: ['identity'] }));
});

test('stale before and after decisions never grants authority', async () => {
  let calls = 0;
  const decision = provider('supersede');
  const advisor = createFourLaneAdvisor({ enabled: true, decision: { ...decision, async decide(...args) { calls++; return decision.decide(...args); } } });
  assert.equal((await advisor.evaluate(envelope('update'), { readCurrentBinding: async () => 'changed' })).code, 'stale');
  assert.equal(calls, 0);
  let reads = 0;
  const report = await advisor.evaluate(envelope('update'), { readCurrentBinding: async () => ++reads === 1 ? binding : 'changed' });
  assert.equal(report.code, 'stale'); assert.equal(report.choice, 'abstain'); assert.equal(calls, 1);
});

test('unknown choice, provider error, abstain and timeout fall back safely', async () => {
  const cases = [provider('unknown'), { name: 'error', async decide() { throw new Error('private-raw-error'); } },
    { name: 'wait', async decide() { return { kind: 'wait', reason: 'wait' }; } },
    { name: 'timeout', decide(_request, signal) { return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private-raw-error')), { once: true })); } }];
  for (const decision of cases) {
    const advisor = createFourLaneAdvisor({ enabled: true, decision, timeoutMs: 20 });
    const report = await advisor.evaluate(envelope(), { readCurrentBinding: async () => binding });
    assert.equal(report.choice, 'abstain'); assert.equal(report.authorized, false);
    assert.equal(JSON.stringify(report).includes('private-raw-error'), false);
    assert.equal(report.dispatched, 0); assert.equal(report.journalEntries, 0);
  }
});

test('policy comparators preserve shadow baseline and synthetic mode only vetoes', async () => {
  const advisor = createFourLaneAdvisor({ enabled: true, decision: provider('skip') });
  const options = { enabled: true, advisor, prepare: async () => ({ envelope: envelope(), readCurrentBinding: async () => binding }) };
  assert.equal(await admissionComparator(options)({}, {}), true);
  assert.equal(await admissionComparator({ ...options, mode: 'synthetic-veto', syntheticFixture: true })({}, {}), false);
  assert.throws(() => admissionComparator({ ...options, mode: 'synthetic-veto' }));
  let calls = 0;
  assert.equal(await admissionComparator({ ...options, baseline: () => false, prepare() { calls++; throw Error(); } })({}, {}), false);
  assert.equal(calls, 0);
  const conflict = conflictComparator({ ...options, advisor: createFourLaneAdvisor({ enabled: true, decision: provider('keep') }),
    prepare: async () => ({ envelope: envelope('update'), readCurrentBinding: async () => binding }), mode: 'synthetic-veto', syntheticFixture: true });
  assert.equal((await conflict({}, {}, {})).action, 'keep_existing');
});

test('deletion is proposal-only and requires exact intent and verified recovery binding', async () => {
  const target = { collection: 'facts', id: 'same-id', recordVersion: digest({ version: 1 }), supportVersion: digest({ evidence: [] }) };
  const targetDigest = digest({ scope, target });
  const intent = { kind: 'explicit_exact_forget', targetDigest };
  const recovery = { targetDigest, snapshotDigest: digest({ before: 'fixture' }), verifiedInSyntheticSimulator: true };
  assert.equal(deletionEnvelope({ scope, target }).choices.includes('propose_delete'), false);
  assert.equal(deletionEnvelope({ scope, target, intent }).choices.includes('propose_delete'), false);
  assert.equal(deletionEnvelope({ scope, target, intent, recovery }).choices.includes('propose_delete'), true);
  assert.equal(deletionEnvelope({ scope, target: { ...target, collection: 'notes' }, intent, recovery }).choices.includes('propose_delete'), false);
  assert.throws(() => deletionEnvelope({ scope: { userId: 'fixture' }, target, intent, recovery }));
});

test('rank adapter returns only exact complete candidate permutations and rejects arbitrary plans', async () => {
  assert.equal(orderPlanReranker(), undefined);
  const input = { query: 'fixture', documents: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] };
  const advisor = createFourLaneAdvisor({ enabled: true, decision: provider('alternative') });
  const adapter = orderPlanReranker({ enabled: true, scope, advisor, alternativeOrder: () => ['b', 'a'] });
  assert.deepEqual(await adapter.rerank(input), [{ id: 'b', score: 1 }, { id: 'a', score: 0.5 }]);
  for (const order of [['b'], ['b', 'b'], ['outside', 'a']]) {
    await assert.rejects(orderPlanReranker({ enabled: true, scope, advisor, alternativeOrder: () => order }).rerank(input));
  }
});

test('input mutation while a rank plan is being prepared invalidates its original binding', async () => {
  const input = { query: 'fixture', documents: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] };
  const adapter = orderPlanReranker({ enabled: true, scope, advisor: createFourLaneAdvisor({ enabled: true, decision: provider('alternative') }),
    async alternativeOrder() { input.documents[1].id = 'changed'; return ['b', 'a']; } });
  await assert.rejects(adapter.rerank(input));
});

test('diagnostic observer failure cannot change the shadow policy result', async () => {
  const options = { enabled: true, advisor: createFourLaneAdvisor({ enabled: true, decision: provider('skip') }),
    prepare: async () => ({ envelope: envelope(), readCurrentBinding: async () => binding }),
    onReport() { throw new Error('observer error'); } };
  assert.equal(await admissionComparator(options)({}, {}), true);
  const conflict = conflictComparator({ ...options, prepare: async () => ({ envelope: envelope('update'), readCurrentBinding: async () => binding }) });
  assert.equal((await conflict({}, {}, {})).action, 'supersede_existing');
});

test('asynchronous diagnostic rejection is isolated from the shadow policy', async () => {
  const options = { enabled: true, advisor: createFourLaneAdvisor({ enabled: true, decision: provider('skip') }),
    prepare: async () => ({ envelope: envelope(), readCurrentBinding: async () => binding }),
    async onReport() { throw new Error('asynchronous observer failure'); } };
  assert.equal(await admissionComparator(options)({}, {}), true);
  await new Promise(resolve => setImmediate(resolve));
});

test('uncooperative provider holds its real slot until settlement, then recovers', async () => {
  let calls = 0; let release;
  const advisor = createFourLaneAdvisor({ enabled: true, timeoutMs: 20, decision: { name: 'uncooperative', decide(request) {
    calls++; const decision = { kind: 'action', candidateId: request.candidates.find(item => item.key === 'admit').id };
    if (calls === 1) return new Promise(resolve => { release = () => resolve(decision); });
    return Promise.resolve(decision);
  } } });
  const options = { readCurrentBinding: async () => binding };
  assert.equal((await advisor.evaluate(envelope(), options)).choice, 'abstain');
  assert.equal((await advisor.evaluate(envelope(), options)).choice, 'abstain');
  assert.equal(calls, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await advisor.evaluate(envelope(), options)).choice, 'admit');
  assert.equal(calls, 2);
});

test('retained options cannot enable a disabled hook or switch shadow into treatment', async () => {
  let calls = 0;
  const disabled = { enabled: false, prepare() { calls++; throw new Error('should not run'); } };
  const hook = admissionComparator(disabled); disabled.enabled = true;
  assert.equal(await hook({}, {}), true); assert.equal(calls, 0);
  const options = { enabled: true, mode: 'shadow', advisor: createFourLaneAdvisor({ enabled: true, decision: provider('skip') }),
    prepare: async () => ({ envelope: envelope(), readCurrentBinding: async () => binding }) };
  const shadow = admissionComparator(options); options.mode = 'synthetic-veto';
  assert.equal(await shadow({}, {}), true);
});

test('rank enable is boolean-only and host plan errors are fixed without raw causes', async () => {
  assert.throws(() => orderPlanReranker({ enabled: 'false' }));
  const marker = 'synthetic-host-callback-private-error';
  const adapter = orderPlanReranker({ enabled: true, scope, advisor: createFourLaneAdvisor({ enabled: true, decision: provider('alternative') }),
    alternativeOrder() { throw new Error(marker); } });
  const error = await adapter.rerank({ query: 'q', documents: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }).catch(error => error);
  assert.equal(error.message, 'Experimental order-plan reranker unavailable.');
  assert.equal(error.cause, undefined); assert.equal(JSON.stringify(error).includes(marker), false);
});
