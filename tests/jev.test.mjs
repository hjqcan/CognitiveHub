import test from 'node:test';
import assert from 'node:assert/strict';
import { JevDecisionProvider, jevPlugin } from '../dist/jev.js';
import { PluginHost } from '../dist/index.js';
const request = { intent: { objective: 'Recover', constraints: ['Use host tasks'] }, observation: { facts: { blocked: true } },
  candidates: [{ id: 'fully-bound-1', description: 'Request new plan', capability: 'replan@1', input: { robot: 'R01' }, effect: 'write', resources: ['R01'] }] };
const response = () => ({ model: 'jev-fixture', answers: { next: { type: 'choice', choice: 'c0',
  probabilities: { c0: 0.8, wait: 0.1, ask: 0.1 }, confidence: 0.5 } }, usage: { input_tokens: 120, output_tokens: 0 } });
const provider = (body, extra = {}) => new JevDecisionProvider({ apiKey: 'test-only-key', model: 'jev-fixture',
  fetch: async () => Response.json(body), ...extra });
const signal = () => new AbortController().signal;

test('Jev sends the actual typed API shape and maps opaque option tokens back to bound actions', async () => {
  let sent;
  const p = provider(response(), { fetch: async (url, init) => { sent = { url, init }; return Response.json(response()); } });
  const result = await p.decide(request, signal());
  assert.equal(sent.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(sent.init.redirect, 'error'); assert.equal(sent.init.headers.Authorization, 'Bearer test-only-key');
  const body = JSON.parse(sent.init.body); assert.equal(body.questions.next.type, 'choice');
  assert.deepEqual(Object.keys(body.questions.next.criteria), ['c0', 'wait', 'ask']);
  assert.equal(result.candidateId, 'fully-bound-1'); assert.equal(result.metadata.confidence, 0.5);
});
test('Jev wait and ask remain non-executable decisions', async () => {
  for (const [choice, kind] of [['wait', 'wait'], ['ask', 'deliberate']]) {
    const r = response(); r.answers.next.choice = choice;
    r.answers.next.probabilities = { c0: 0, wait: +(choice === 'wait'), ask: +(choice === 'ask') };
    assert.equal((await provider(r).decide(request, signal())).kind, kind);
  }
});
for (const [name, mutate] of [
  ['unknown choice', r => { r.answers.next.choice = 'shell'; }],
  ['missing distribution option', r => { delete r.answers.next.probabilities.ask; }],
  ['extra distribution option', r => { r.answers.next.probabilities.extra = 0; }],
  ['negative probability', r => { r.answers.next.probabilities.wait = -0.1; }],
  ['unnormalized distribution', r => { r.answers.next.probabilities.c0 = 0.2; }],
  ['choice not maximal', r => { r.answers.next.choice = 'ask'; }],
  ['missing confidence', r => { delete r.answers.next.confidence; }],
  ['invalid token usage', r => { r.usage.input_tokens = -1; }],
]) test(`Jev rejects ${name}`, async () => {
  const r = response(); mutate(r); await assert.rejects(provider(r).decide(request, signal()), { code: 'jev-schema' });
});
test('HTTP errors are not retried or echoed with vendor body/secrets', async () => {
  let calls = 0;
  const p = provider(null, { fetch: async () => { calls++; return new Response('sensitive content', { status: 429 }); } });
  await assert.rejects(p.decide(request, signal()), error => error.code === 'jev-http-429' && !error.message.includes('sensitive'));
  assert.equal(calls, 1);
});
test('fetch cancellation and deadlines are enforced even by an uncooperative transport', async () => {
  const p = provider(null, { timeoutMs: 10, fetch: () => new Promise(() => {}) });
  await assert.rejects(p.decide(request, signal()), { code: 'timeout' });
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(provider(response()).decide(request, controller.signal), /cancelled/);
});
test('input and response size limits reject oversized payloads', async () => {
  await assert.rejects(provider(response(), { maxPayloadBytes: 10 }).decide(request, signal()), { code: 'jev-input-limit' });
  const p = provider(null, { maxPayloadBytes: 2000, fetch: async () => new Response('x'.repeat(3000)) });
  await assert.rejects(p.decide(request, signal()), { code: 'jev-output-limit' });
});
test('unsafe endpoints are rejected before exposing credentials', () => {
  for (const endpoint of ['http://localhost', 'https://user:pass@example.com', 'https://example.com/?token=x'])
    assert.throws(() => provider(response(), { endpoint }), { code: 'invalid-endpoint' });
});
test('Jev can be installed as a service plugin', async () => {
  const host = new PluginHost(); host.install(jevPlugin({ apiKey: 'test', model: 'jev-fixture', fetch: async () => Response.json(response()) }));
  await host.start(); assert.equal(host.resolve('decision.v1').name, 'jev-fixture');
  await host.stop('cognitive.jev'); assert.throws(() => host.resolve('decision.v1'));
});
