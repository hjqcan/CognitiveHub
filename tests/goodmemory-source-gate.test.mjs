import assert from 'node:assert/strict';
import test from 'node:test';
import { createEnvelope, digest } from '../examples/goodmemory-four-lane/advisor.mjs';
import { createSourceBoundAdvisor } from '../examples/goodmemory-four-lane/source-gate.mjs';

const scope = { tenantId: 'synthetic', userId: 'development', workspaceId: 'test', agentId: null, sessionId: null };
const lanes = { admission: ['admit', 'skip'], update: ['keep', 'supersede'], delete: ['retain', 'propose_delete'], rerank: ['identity', 'alternative'] };
const envelope = lane => createEnvelope({ lane, scope, binding: digest({ epoch: 1 }), facts: { content: 'Policy-permitted synthetic evidence.' }, choices: [...lanes[lane], 'abstain'] });
const receipt = (descriptor, status = 'current') => ({ status, requestDigest: descriptor.requestDigest, scopeDigest: digest(descriptor.scope), binding: descriptor.binding });
const decision = key => ({ name: 'synthetic-development', async decide(request) {
  return key === 'abstain' ? { kind: 'wait', reason: 'Development control' }
    : { kind: 'action', candidateId: request.candidates.find(candidate => candidate.key === key)?.id ?? 'missing', metadata: { confidence: 1, authorized: true } };
} });
const invariants = result => {
  assert.equal(result.authorized, false); assert.equal(result.memoryMutated, false);
  assert.equal(result.dispatched, 0); assert.equal(result.journalEntries, 0);
  assert.ok(result.providerCalls <= 1); assert.ok(result.supportChecks <= 2);
};

for (const [lane, [, selected]] of Object.entries(lanes)) {
  test(`${lane}: current support permits finite proposal and abstention without authority`, async () => {
    for (const key of [selected, 'abstain']) {
      const result = await createSourceBoundAdvisor({ enabled: true, decision: decision(key), inspectCurrent: descriptor => receipt(descriptor) }).evaluate(envelope(lane));
      assert.equal(result.code, key === 'abstain' ? 'abstained' : 'advised'); assert.equal(result.choice, key);
      assert.deepEqual([result.supportChecks, result.providerCalls], [2, 1]); invariants(result);
    }
  });
  test(`${lane}: matching version is insufficient when current support is unavailable or revoked`, async () => {
    for (const status of ['unsupported', 'unavailable']) {
      const result = await createSourceBoundAdvisor({ enabled: true, decision: decision(selected), inspectCurrent: descriptor => receipt(descriptor, status) }).evaluate(envelope(lane));
      assert.equal(result.code, status === 'unsupported' ? 'source_unsupported' : 'source_unavailable');
      assert.equal(result.choice, 'abstain'); assert.deepEqual([result.supportChecks, result.providerCalls], [1, 0]); invariants(result);
    }
  });
}

test('wrong scope, request and binding are distinguished without consulting the model', async () => {
  for (const [field, code] of [['scopeDigest', 'invalid_support'], ['requestDigest', 'invalid_support'], ['binding', 'stale']]) {
    const advisor = createSourceBoundAdvisor({ enabled: true, decision: decision('admit'), inspectCurrent: descriptor => ({ ...receipt(descriptor), [field]: digest('another') }) });
    const result = await advisor.evaluate(envelope('admission'));
    assert.equal(result.code, code); assert.equal(result.providerCalls, 0); invariants(result);
  }
});

test('malformed and thrown inspector results have fixed, non-sensitive diagnostics', async () => {
  for (const inspectCurrent of [() => null, descriptor => ({ ...receipt(descriptor), secret: 'SYNTHETIC_MARKER' }), () => { throw Error('SYNTHETIC_MARKER'); }]) {
    const result = await createSourceBoundAdvisor({ enabled: true, decision: decision('keep'), inspectCurrent }).evaluate(envelope('update'));
    assert.ok(['invalid_support', 'source_unavailable'].includes(result.code)); assert.equal(result.providerCalls, 0);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_MARKER'), false); invariants(result);
  }
});

test('default disabled does not read hostile envelope or missing dependencies', async () => {
  let reads = 0;
  const hostile = Object.defineProperty({}, 'facts', { get() { reads++; throw Error('must not read'); } });
  const result = await createSourceBoundAdvisor().evaluate(hostile);
  assert.equal(result.code, 'disabled'); assert.equal(reads, 0); assert.equal(result.supportChecks, 0); invariants(result);
});

test('source gate enablement and timeout are explicit', () => {
  assert.throws(() => createSourceBoundAdvisor({ enabled: 'false' }), /Invalid current-support/);
  assert.throws(() => createSourceBoundAdvisor({ enabled: true }), /Invalid current-support/);
  assert.throws(() => createSourceBoundAdvisor({ timeoutMs: 3001 }), /Invalid current-support/);
});
