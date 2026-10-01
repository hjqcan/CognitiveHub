import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as root from '@cognitive-hub/core';
import { createGoodMemoryShadowAdvisor, createConfiguredGoodMemoryShadowAdvisor } from '@cognitive-hub/core/goodmemory-shadow';
import { JevDecisionProvider } from '@cognitive-hub/core/jev';

const snapshot = { schemaVersion: 1, digest: 'a'.repeat(64), previousVersion: 'b'.repeat(64),
  scope: { userId: 'private-user', workspaceId: 'private-workspace', sessionId: 'private-session' },
  source: { id: 'private-source-new', content: 'PRIVATE_SOURCE_TEXT' },
  previous: { sources: [{ id: 'private-source-old', content: 'PRIVATE_OLD_TEXT' }] },
  allowedChoices: ['keep', 'supersede', 'abstain'] };
const signal = () => new AbortController().signal;
const choose = (choice = 'supersede', metadata = { confidence: 1 }) => ({ name: 'offline', async decide(request) {
  return { kind: 'action', candidateId: request.candidates.find(candidate => candidate.key === choice).id, metadata };
} });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function inspectRuntime(t) {
  let live = 0, claims = 0, previews = 0;
  const facts = [];
  const execute = root.CognitiveHub.prototype.execute;
  const append = root.MemoryDecisionStore.prototype.append;
  const claim = root.MemoryJournal.prototype.claim;
  t.mock.method(root.CognitiveHub.prototype, 'execute', function (...args) {
    if (args[2]?.live) live++; else previews++;
    return execute.apply(this, args);
  });
  t.mock.method(root.MemoryJournal.prototype, 'claim', function (...args) { claims++; return claim.apply(this, args); });
  t.mock.method(root.MemoryDecisionStore.prototype, 'append', function (record) {
    if (record.request) facts.push(record.request.observation.facts);
    return append.call(this, record);
  });
  t.after(() => { assert.equal(live, 0, 'no live dispatch entry'); assert.equal(claims, 0, 'no execution journal claims'); });
  return { facts, previews: () => previews };
}

test('opt-in package export ships JavaScript and declarations without widening the root API', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.private, true);
  assert.equal(manifest.version, '0.3.0');
  assert.deepEqual(manifest.exports['./goodmemory-shadow'], { types: './dist/goodmemory-shadow.d.ts', import: './dist/goodmemory-shadow.js' });
  assert.ok(manifest.files.includes('dist'));
  assert.equal(root.createGoodMemoryShadowAdvisor, undefined);
  assert.equal((await readFile(new URL('../dist/goodmemory-shadow.d.ts', import.meta.url), 'utf8')).includes('Promise<unknown>'), true);
  const example = await import('../examples/goodmemory-shadow-adapter.mjs');
  assert.equal(example.createGoodMemoryShadowAdvisor, createGoodMemoryShadowAdvisor);
});

test('default retains zero history and runs actual advisory preview with recordFacts:false', async t => {
  const inspect = inspectRuntime(t);
  const provider = createGoodMemoryShadowAdvisor({ decision: { name: 'deterministic', async decide(request) {
    assert.equal(Object.isFrozen(request), true);
    assert.equal(request.observation.facts.previousVersion, snapshot.previousVersion);
    assert.equal('baseline' in request.observation.facts, false);
    return choose().decide(request);
  } } });
  for (let i = 0; i < 3; i++) {
    const result = await provider.advise(snapshot, signal());
    assert.deepEqual(result, { choice: 'supersede', evidenceSourceRecordIds: ['private-source-new', 'private-source-old'], confidence: 1 });
  }
  assert.equal(inspect.previews(), 3);
  assert.deepEqual(inspect.facts, [null, null, null]);
  assert.deepEqual(provider.history, []);
  assert.equal(Object.isFrozen(provider.history), true);
  assert.equal('replays' in provider, false);
});

test('opt-in history is bounded, redacted, copied and frozen', async t => {
  inspectRuntime(t);
  const provider = createGoodMemoryShadowAdvisor({ decision: choose('keep', { confidence: 0.75, reason: 'PRIVATE_MODEL_REASON', extra: 'PRIVATE_METADATA' }), maxReplayRecords: 2 });
  const empty = provider.history;
  await provider.advise(snapshot, signal());
  const first = provider.history;
  assert.equal(first.length, 1);
  for (const digest of ['c', 'd']) await provider.advise({ ...snapshot, digest: digest.repeat(64) }, signal());
  const history = provider.history;
  assert.equal(history.length, 2);
  assert.deepEqual(history.map(entry => entry.providerRequestDigest), ['c'.repeat(64), 'd'.repeat(64)]);
  assert.deepEqual(empty, []);
  assert.equal(first.length, 1, 'a prior view is a snapshot, not a live alias');
  assert.notEqual(provider.history, history);
  assert.equal(Object.isFrozen(history), true);
  const record = history[0];
  assert.equal(Object.isFrozen(record), true);
  assert.throws(() => history.push(record), TypeError);
  assert.throws(() => { record.choice = 'supersede'; }, TypeError);
  assert.deepEqual(Object.keys(record).sort(), ['providerRequestDigest', 'previousVersion', 'decisionId', 'choice', 'outcome', 'failureCategory', 'elapsedMs', 'dispatched', 'journalEntries', 'confidence', 'cleanup'].sort());
  assert.equal(record.dispatched, 0); assert.equal(record.journalEntries, 0);
  assert.equal(record.previousVersion, snapshot.previousVersion);
  assert.match(record.decisionId, /^[a-f0-9-]{36}$/);
  assert.equal(record.choice, 'keep'); assert.equal(record.outcome, 'advised');
  assert.equal(record.failureCategory, null); assert.equal(record.cleanup, 'stopped');
  assert.equal(record.confidence, 0.75); assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE_|private-(user|workspace|session|source)/);
});

test('retention/options enforce a finite bound and reject instance evaluator labels', () => {
  for (const maxReplayRecords of [-1, 129, 1.5, Infinity, NaN, '2', null]) {
    assert.throws(() => createGoodMemoryShadowAdvisor({ decision: choose(), maxReplayRecords }), /maxReplayRecords/);
  }
  for (const timeoutMs of [0, -1, 1.5, Infinity, NaN, 2 ** 31]) {
    assert.throws(() => createGoodMemoryShadowAdvisor({ decision: choose(), timeoutMs }), /timeoutMs/);
  }
  for (const maxReplayRecords of [0, 128]) assert.ok(createGoodMemoryShadowAdvisor({ decision: choose(), maxReplayRecords }));
  assert.throws(() => createGoodMemoryShadowAdvisor({ decision: choose(), baseline: 'keep' }), /labels separately/);
});

test('baseline-bearing provider inputs are rejected before reaching a model', async () => {
  let called = false;
  const provider = createGoodMemoryShadowAdvisor({ maxReplayRecords: 2, decision: { name: 'never', async decide() { called = true; return { kind: 'wait', reason: 'unused' }; } } });
  await assert.rejects(provider.advise({ ...snapshot, baseline: 'supersede' }, signal()), /labels separately/);
  assert.equal(called, false); assert.deepEqual(provider.history, []);
});

for (const kind of ['wait', 'deliberate']) test(`explicit ${kind} produces finite abstention without retaining reason`, async t => {
  inspectRuntime(t);
  const provider = createGoodMemoryShadowAdvisor({ maxReplayRecords: 1, decision: { name: 'abstainer', async decide() { return { kind, reason: 'PRIVATE_ABSTENTION_REASON' }; } } });
  assert.deepEqual(await provider.advise(snapshot, signal()), { choice: 'abstain', evidenceSourceRecordIds: [] });
  assert.equal(provider.history[0].outcome, 'abstained'); assert.equal(provider.history[0].failureCategory, null);
  assert.doesNotMatch(JSON.stringify(provider.history), /PRIVATE_/);
});

test('abstain-only eligibility bypasses the model and emits no action', async t => {
  inspectRuntime(t);
  let calls = 0;
  const provider = createGoodMemoryShadowAdvisor({ maxReplayRecords: 1, decision: { name: 'never', async decide() { calls++; throw new Error('must not call'); } } });
  assert.deepEqual(await provider.advise({ ...snapshot, allowedChoices: ['abstain'] }, signal()), { choice: 'abstain', evidenceSourceRecordIds: [] });
  assert.equal(calls, 0); assert.equal(provider.history[0].outcome, 'abstained');
});

test('unknown candidate is a failed response, never a successful abstention', async t => {
  inspectRuntime(t);
  const provider = createGoodMemoryShadowAdvisor({ maxReplayRecords: 1, decision: { name: 'invalid', async decide() { return { kind: 'action', candidateId: 'PRIVATE_DELETE_ALL' }; } } });
  assert.deepEqual(await provider.advise(snapshot, signal()), { choice: 'invalid_hub_result', evidenceSourceRecordIds: [] });
  assert.equal(provider.history[0].choice, null); assert.equal(provider.history[0].outcome, 'failed');
  assert.equal(provider.history[0].failureCategory, 'invalid-response');
  assert.doesNotMatch(JSON.stringify(provider.history), /PRIVATE_/);
});

test('raw thrown errors and codes never escape into history', async t => {
  inspectRuntime(t);
  const provider = createGoodMemoryShadowAdvisor({ maxReplayRecords: 1, decision: { name: 'error', async decide() {
    throw new root.HubError('PRIVATE_ERROR_CODE', 'PRIVATE_ERROR_MESSAGE');
  } } });
  assert.equal((await provider.advise(snapshot, signal())).choice, 'invalid_hub_result');
  assert.equal(provider.history[0].failureCategory, 'provider-error');
  assert.doesNotMatch(JSON.stringify(provider.history), /PRIVATE_/);
});

for (const confidence of [-1, 2, 'PRIVATE_CONFIDENCE']) test(`invalid confidence ${confidence} is not retained or silently accepted`, async t => {
  inspectRuntime(t);
  const provider = createGoodMemoryShadowAdvisor({ maxReplayRecords: 1, decision: choose('keep', { confidence }) });
  assert.equal((await provider.advise(snapshot, signal())).choice, 'invalid_hub_result');
  assert.equal('confidence' in provider.history[0], false);
  assert.equal(provider.history[0].failureCategory, 'invalid-response');
});

test('timeouts stay bounded; queued callers do not release an unsettled shared slot; settlement recovers', async t => {
  inspectRuntime(t);
  const gate = deferred(); let calls = 0;
  const provider = createGoodMemoryShadowAdvisor({ timeoutMs: 15, maxReplayRecords: 8, decision: { name: 'slow', async decide(request) {
    calls++; if (calls === 1) await gate.promise; return choose().decide(request);
  } } });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await provider.advise(snapshot, signal())).choice, 'invalid_hub_result');
    assert.equal(calls, 1, 'the timed-out vendor call still holds concurrency-one');
    assert.equal(provider.history[0].cleanup, 'pending');
    assert.ok(provider.history.every(record => record.failureCategory === 'timeout'));
  } finally { gate.resolve(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await provider.advise(snapshot, signal())).choice, 'supersede');
  assert.equal(calls, 2);
  assert.equal(provider.history.at(-1).cleanup, 'stopped');
});

test('host cancellation returns safe failure and retains only a normalized category', async t => {
  inspectRuntime(t);
  const entered = deferred(), gate = deferred(), controller = new AbortController();
  const provider = createGoodMemoryShadowAdvisor({ timeoutMs: 50, maxReplayRecords: 2, decision: { name: 'cancel', async decide(request) {
    entered.resolve(); await gate.promise; return choose().decide(request);
  } } });
  const pending = provider.advise(snapshot, controller.signal);
  await entered.promise; controller.abort(new Error('PRIVATE_CANCELLATION_REASON'));
  try {
    assert.equal((await pending).choice, 'invalid_hub_result');
    assert.equal(provider.history[0].failureCategory, 'cancelled');
    assert.equal(provider.history[0].cleanup, 'pending');
    assert.doesNotMatch(JSON.stringify(provider.history), /PRIVATE_/);
  } finally { gate.resolve(); }
});

test('already-aborted calls never invoke the model', async t => {
  inspectRuntime(t); let calls = 0;
  const provider = createGoodMemoryShadowAdvisor({ maxReplayRecords: 1, decision: { name: 'never', async decide() { calls++; throw new Error('unexpected'); } } });
  const controller = new AbortController(); controller.abort('PRIVATE_ABORT_REASON');
  assert.equal((await provider.advise(snapshot, controller.signal)).choice, 'invalid_hub_result');
  assert.equal(calls, 0); assert.equal(provider.history[0].failureCategory, 'cancelled');
});

test('typedChoice transport composes using only an injected offline response', async t => {
  inspectRuntime(t); let requests = 0;
  const decision = new JevDecisionProvider({ apiKey: 'synthetic-test-placeholder', model: 'offline-fixture',
    fetch: async (_url, init) => {
      requests++;
      const body = JSON.parse(init.body);
      assert.equal(body.questions.next.type, 'choice');
      assert.deepEqual(Object.keys(body.questions.next.criteria), ['c0', 'c1', 'wait', 'ask']);
      return Response.json({ model: 'offline-fixture', answers: { next: { type: 'choice', choice: 'c1',
        probabilities: { c0: 0, c1: 1, wait: 0, ask: 0 }, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 0 } });
    } });
  const provider = createGoodMemoryShadowAdvisor({ decision });
  const result = await provider.advise(snapshot, signal());
  assert.equal(requests, 1); assert.equal(result.choice, 'supersede'); assert.equal(result.confidence, 1);
  assert.deepEqual(provider.history, []);
});

test('mutable caller aliases cannot change the model facts, evidence, or retained digest mid-flight', async t => {
  inspectRuntime(t);
  const entered = deferred(), gate = deferred();
  const input = structuredClone(snapshot);
  const provider = createGoodMemoryShadowAdvisor({ maxReplayRecords: 1, decision: { name: 'detached', async decide(request) {
    entered.resolve(); await gate.promise;
    assert.equal(request.observation.facts.source.content, 'PRIVATE_SOURCE_TEXT');
    assert.equal(request.observation.facts.digest, 'a'.repeat(64));
    return choose('keep').decide(request);
  } } });
  const pending = provider.advise(input, signal());
  await entered.promise;
  input.source.id = 'CHANGED_SOURCE_ID'; input.source.content = 'CHANGED_CONTENT'; input.digest = 'e'.repeat(64);
  input.previous.sources[0].id = 'CHANGED_PREVIOUS_ID'; input.allowedChoices.length = 0;
  gate.resolve();
  const result = await pending;
  assert.deepEqual(result.evidenceSourceRecordIds, ['private-source-new', 'private-source-old']);
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.evidenceSourceRecordIds), true);
  assert.equal(provider.history[0].providerRequestDigest, 'a'.repeat(64));
});

test('simultaneous callers share one underlying slot and retain independently bounded results', async t => {
  inspectRuntime(t);
  const entered = deferred(), gate = deferred(); let active = 0, maximum = 0, calls = 0;
  const provider = createGoodMemoryShadowAdvisor({ timeoutMs: 1000, maxReplayRecords: 1, decision: { name: 'serial', async decide(request) {
    active++; calls++; maximum = Math.max(maximum, active);
    try { if (calls === 1) { entered.resolve(); await gate.promise; } return choose().decide(request); }
    finally { active--; }
  } } });
  const first = provider.advise(snapshot, signal());
  await entered.promise;
  const second = provider.advise({ ...snapshot, digest: 'f'.repeat(64) }, signal());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); gate.resolve();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.choice === 'supersede'));
  assert.equal(maximum, 1); assert.equal(calls, 2); assert.equal(provider.history.length, 1);
});

for (const confidence of [NaN, Infinity, -Infinity, null]) test(`non-finite/null confidence ${confidence} fails closed`, async t => {
  inspectRuntime(t);
  const provider = createGoodMemoryShadowAdvisor({ maxReplayRecords: 1, decision: choose('keep', { confidence }) });
  assert.equal((await provider.advise(snapshot, signal())).choice, 'invalid_hub_result');
  assert.equal(provider.history[0].failureCategory, 'invalid-response');
  assert.equal('confidence' in provider.history[0], false);
});

test('malformed requests cannot inject raw correlation fields into retained history', async () => {
  let calls = 0;
  const provider = createGoodMemoryShadowAdvisor({ maxReplayRecords: 1, decision: { name: 'never', async decide() { calls++; throw new Error('unexpected'); } } });
  for (const input of [
    { ...snapshot, digest: 'PRIVATE_RAW_DIGEST' },
    { ...snapshot, previousVersion: 'PRIVATE_RAW_VERSION' },
    { ...snapshot, allowedChoices: ['delete', 'abstain'] },
    { ...snapshot, allowedChoices: ['keep'] },
    { ...snapshot, scope: { userId: 3 } },
  ]) await assert.rejects(provider.advise(input, signal()), /Invalid GoodMemory shadow/);
  assert.equal(calls, 0); assert.deepEqual(provider.history, []);
});


const configCanary = 'SYNTHETIC_PRIVATE_CONFIG_CANARY';
const enabledConfig = (extra = {}) => ({ enabled: true, apiKeyEnv: 'JEV_API_KEY', model: 'offline-explicit-pin', ...extra });
const configDeps = (extra = {}) => ({ readEnv: () => configCanary, fetch: async () => { throw new Error('Unexpected fake request'); }, ...extra });
const choiceResponse = (choice = 'c1') => Response.json({ model: 'offline-explicit-pin', answers: { next: { type: 'choice', choice,
  probabilities: { c0: choice === 'c0' ? 1 : 0, c1: choice === 'c1' ? 1 : 0, wait: choice === 'wait' ? 1 : 0, ask: choice === 'ask' ? 1 : 0 }, confidence: 1 } },
  usage: { input_tokens: 1, output_tokens: 0 } });
function safeConfigError(callback, code = 'invalid-shadow-config') {
  assert.throws(callback, error => {
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error) + JSON.stringify(error), /SYNTHETIC_PRIVATE_CONFIG_CANARY/);
    return true;
  });
}

test('config factory is subpath-only and disabled before secret, dependency, or serialization hooks', () => {
  assert.equal(root.createConfiguredGoodMemoryShadowAdvisor, undefined);
  let touched = 0;
  const forbidden = () => { touched++; throw new Error(configCanary); };
  const config = { enabled: false, get apiKeyEnv() { return forbidden(); }, get apiKey() { return forbidden(); },
    get model() { return forbidden(); }, get endpoint() { return forbidden(); }, toJSON: forbidden };
  const dependencies = { get readEnv() { return forbidden(); }, get fetch() { return forbidden(); } };
  for (const value of [undefined, {}, config]) {
    const result = createConfiguredGoodMemoryShadowAdvisor(value, dependencies);
    assert.deepEqual(result, { enabled: false });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(JSON.stringify(result), '{"enabled":false}');
    assert.equal('provider' in result, false);
  }
  assert.equal(touched, 0);
});

test('enabled config rejects unknown/raw key, accessor, and toJSON fields without reading their values', () => {
  let touched = 0;
  const forbidden = () => { touched++; throw new Error(configCanary); };
  for (const field of ['apiKey', 'unknown', configCanary, 'toJSON', Symbol(configCanary)]) {
    const config = enabledConfig();
    Object.defineProperty(config, field, { enumerable: true, get: forbidden });
    safeConfigError(() => createConfiguredGoodMemoryShadowAdvisor(config, configDeps({ readEnv: forbidden })));
  }
  for (const field of ['enabled', 'apiKeyEnv', 'model', 'endpoint', 'timeoutMs', 'maxReplayRecords']) {
    const config = enabledConfig();
    Object.defineProperty(config, field, { enumerable: true, get: forbidden });
    safeConfigError(() => createConfiguredGoodMemoryShadowAdvisor(config, configDeps({ readEnv: forbidden })));
  }
  assert.equal(touched, 0);
});

test('config errors reject malformed values and model/name limits before resolving any key', () => {
  let reads = 0;
  const deps = configDeps({ readEnv: () => { reads++; return configCanary; } });
  for (const config of [null, [], true, configCanary, 1, { enabled: 1 }, { enabled: null },
    Object.create(enabledConfig()), enabledConfig({ model: undefined }), enabledConfig({ model: '' }),
    enabledConfig({ model: ' ' }), enabledConfig({ model: 1 }), enabledConfig({ model: 'a'.repeat(244) }),
    enabledConfig({ apiKeyEnv: undefined }), enabledConfig({ apiKeyEnv: '' }), enabledConfig({ apiKeyEnv: ' ' }),
    enabledConfig({ apiKeyEnv: '1BAD' }), enabledConfig({ apiKeyEnv: 'BAD-NAME' }), enabledConfig({ apiKeyEnv: 1 }),
    enabledConfig({ apiKeyEnv: 'a'.repeat(257) })]) {
    safeConfigError(() => createConfiguredGoodMemoryShadowAdvisor(config, deps));
  }
  for (const endpoint of ['', 1, null, `http://example.invalid/${configCanary}`, `https://${configCanary}@example.invalid`,
    `https://example.invalid/?key=${configCanary}`, `https://example.invalid/#${configCanary}`, configCanary]) {
    safeConfigError(() => createConfiguredGoodMemoryShadowAdvisor(enabledConfig({ endpoint }), deps));
  }
  for (const timeoutMs of [0, -1, 1.5, 2 ** 31, Infinity, NaN, null, '10']) {
    safeConfigError(() => createConfiguredGoodMemoryShadowAdvisor(enabledConfig({ timeoutMs }), deps));
  }
  for (const maxReplayRecords of [-1, 129, 1.5, Infinity, NaN, null, '1']) {
    safeConfigError(() => createConfiguredGoodMemoryShadowAdvisor(enabledConfig({ maxReplayRecords }), deps));
  }
  assert.equal(reads, 0);
  assert.equal(createConfiguredGoodMemoryShadowAdvisor(enabledConfig({ model: 'a'.repeat(243) }), deps).provider.name.length, 256);
});

test('config uses only explicit env resolver and gives finite errors for missing, blank, nonstring, or throwing key resolution', () => {
  safeConfigError(() => createConfiguredGoodMemoryShadowAdvisor(enabledConfig()), 'invalid-shadow-dependencies');
  let coercions = 0;
  const hostileKey = { toString() { coercions++; throw new Error(configCanary); }, toJSON() { coercions++; throw new Error(configCanary); } };
  for (const key of [undefined, null, '', '   ', 1, hostileKey, 'a'.repeat(513), 'line\nfeed']) {
    safeConfigError(() => createConfiguredGoodMemoryShadowAdvisor(enabledConfig(), configDeps({ readEnv: () => key })), 'shadow-key-unavailable');
  }
  safeConfigError(() => createConfiguredGoodMemoryShadowAdvisor(enabledConfig(), configDeps({ readEnv: () => { throw new Error(configCanary); } })), 'shadow-key-resolver-error');
  assert.equal(coercions, 0);
  for (const dependencies of [{}, { readEnv: 1 }, { readEnv: () => configCanary, fetch: 1 },
    { get readEnv() { throw new Error(configCanary); } }, { readEnv: () => configCanary, get fetch() { throw new Error(configCanary); } }]) {
    safeConfigError(() => createConfiguredGoodMemoryShadowAdvisor(enabledConfig(), dependencies), 'invalid-shadow-dependencies');
  }
});

test('config wires actual Jev authorization and bounded typed choices without retaining config or credentials', async t => {
  inspectRuntime(t);
  let reads = 0, calls = 0;
  const config = enabledConfig({ endpoint: 'https://shadow.example.invalid/v1/choice', timeoutMs: 1000 });
  const configured = createConfiguredGoodMemoryShadowAdvisor(config, configDeps({
    readEnv(name) { reads++; assert.equal(name, 'JEV_API_KEY'); return configCanary; },
    async fetch(url, init) {
      calls++; assert.equal(url, 'https://shadow.example.invalid/v1/choice');
      assert.equal(init.headers.Authorization, `Bearer ${configCanary}`);
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'offline-explicit-pin'); assert.equal(body.questions.next.type, 'choice');
      assert.deepEqual(Object.keys(body.questions.next.criteria), ['c0', 'c1', 'wait', 'ask']);
      assert.deepEqual(body.state.candidates.map(candidate => candidate.input.choice), ['keep', 'supersede']);
      assert.ok(body.state.candidates.every(candidate => candidate.effect === 'read'));
      assert.doesNotMatch(init.body, /SYNTHETIC_PRIVATE_CONFIG_CANARY|JEV_API_KEY|apiKey/);
      return choiceResponse();
    },
  }));
  assert.equal(reads, 1); assert.equal(calls, 0, 'construction never makes a request');
  assert.equal(Object.isFrozen(configured), true); assert.equal(Object.isFrozen(configured.provider), true);
  assert.deepEqual(Object.keys(configured).sort(), ['enabled', 'provider']);
  config.model = configCanary; config.toJSON = () => { throw new Error(configCanary); };
  assert.equal(configured.provider.name, 'cognitivehub:offline-explicit-pin');
  assert.throws(() => { configured.enabled = false; }, TypeError);
  assert.throws(() => { configured.provider.name = 'changed'; }, TypeError);
  const answer = await configured.provider.advise(snapshot, signal());
  assert.equal(answer.choice, 'supersede'); assert.equal(calls, 1); assert.equal(reads, 1);
  assert.deepEqual(configured.provider.history, []);
  assert.doesNotMatch(JSON.stringify(configured), /SYNTHETIC_PRIVATE_CONFIG_CANARY|JEV_API_KEY|apiKey|endpoint|readEnv/);
});

for (const [name, fetch, category] of [
  ['401', async () => new Response(configCanary, { status: 401 }), 'provider-error'],
  ['503', async () => new Response(configCanary, { status: 503 }), 'provider-error'],
  ['transport', async () => { throw new Error(configCanary); }, 'provider-error'],
  ['malformed JSON', async () => new Response(configCanary), 'invalid-response'],
  ['invalid choice', async () => choiceResponse(configCanary), 'invalid-response'],
]) test(`config ${name} failure stays redacted through advice and bounded history`, async t => {
  inspectRuntime(t);
  const { provider } = createConfiguredGoodMemoryShadowAdvisor(enabledConfig({ maxReplayRecords: 1 }), configDeps({ fetch }));
  const answer = await provider.advise(snapshot, signal());
  assert.equal(answer.choice, 'invalid_hub_result');
  assert.equal(provider.history[0].failureCategory, category);
  assert.doesNotMatch(JSON.stringify({ answer, provider }), /SYNTHETIC_PRIVATE_CONFIG_CANARY/);
});

test('config retains existing cancellation, allowed-choice, and abstention guards', async t => {
  inspectRuntime(t); let calls = 0;
  const { provider } = createConfiguredGoodMemoryShadowAdvisor(enabledConfig({ maxReplayRecords: 3 }), configDeps({ fetch: async () => { calls++; return choiceResponse('wait'); } }));
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal((await provider.advise(snapshot, cancelled.signal)).choice, 'invalid_hub_result');
  assert.equal(provider.history[0].failureCategory, 'cancelled'); assert.equal(calls, 0);
  assert.equal((await provider.advise({ ...snapshot, allowedChoices: ['abstain'] }, signal())).choice, 'abstain');
  assert.equal(calls, 0);
  assert.equal((await provider.advise(snapshot, signal())).choice, 'abstain'); assert.equal(calls, 1);
  assert.ok(provider.history.every(record => record.dispatched === 0 && record.journalEntries === 0));
});
