// Regression gates for the two independently reproduced v1 limitations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, entry, gm, scope, coreScope, query, oldText, newText } from './current-state-fixture.mjs';
import { createCurrentStateRecallHost } from '../../examples/goodmemory-four-lane/current-state-recall.mjs';

const options = { skip: !entry };
const request = { scope: coreScope, query };
const unavailable = { code: 'current_state_unavailable' };
const baselineOnly = result => {
  assert.equal(result.facts.length, 2);
  assert.ok(!result.metadata.policyApplied.includes('reranked'));
};

test('v2: genuine configured advice remains usable and bound to this exact source envelope', options, async () => {
  const f = await fixture(); let envelope;
  const host = createCurrentStateRecallHost({ enabled: true, ...f, prepareRerank: async args => (envelope = await f.prepareRerank(args)) });
  const result = await host.memory.recall(request);
  assert.ok(result.metadata.policyApplied.includes('reranked'));
  assert.equal(f.reports[0].requestDigest, envelope.digest);
  assert.equal(f.reports[0].supportChecks, 2); assert.equal(f.reports[0].providerCalls, 1);
  assert.equal(f.calls(), 1);
});

test('v2: a genuine foreign-scope report cannot advise another request', options, async () => {
  const foreignScope = { ...scope, userId: 'different-user', workspaceId: 'different-workspace' };
  const first = await fixture({ scope: foreignScope });
  await createCurrentStateRecallHost({ enabled: true, ...first }).memory.recall({ query,
    scope: Object.fromEntries(Object.entries(foreignScope).filter(([, value]) => value !== null)) });
  assert.equal(first.reports[0].code, 'advised');
  const second = await fixture(); let envelope;
  const host = createCurrentStateRecallHost({ enabled: true, ...second,
    advisor: { evaluate: async e => { envelope = e; return first.reports[0]; } } });
  const result = await host.memory.recall(request);
  assert.notEqual(first.reports[0].requestDigest, envelope.digest);
  baselineOnly(result); assert.equal(second.calls(), 0);
  assert.ok(result.facts.every(fact => fact.userId === coreScope.userId));
});

test('v2: an earlier successful report cannot survive a new canonical source binding', options, async () => {
  const f = await fixture(); const first = createCurrentStateRecallHost({ enabled: true, ...f });
  await first.memory.recall(request); const cached = f.reports[0]; await f.update();
  let envelope; const host = createCurrentStateRecallHost({ enabled: true, ...f,
    advisor: { evaluate: async e => { envelope = e; return cached; } } });
  const result = await host.memory.recall(request);
  assert.notEqual(cached.requestDigest, envelope.digest); baselineOnly(result);
  assert.ok(result.facts.some(fact => fact.content === newText));
  assert.ok(!result.facts.some(fact => fact.content === oldText)); assert.equal(f.calls(), 1);
});

const malformed = {
  requestDigest: report => ({ ...report, requestDigest: '0'.repeat(64) }),
  schemaVersion: report => ({ ...report, schemaVersion: 2 }),
  mode: report => ({ ...report, mode: 'production' }),
  lane: report => ({ ...report, lane: 'admission' }),
  missingRequest: report => { const result = { ...report }; delete result.requestDigest; return result; },
  missingSourceCheck: report => ({ ...report, supportChecks: 1 }),
  providerCount: report => ({ ...report, providerCalls: 0 }),
  extraAuthority: report => ({ ...report, authority: 'approved' }),
};
for (const [name, corrupt] of Object.entries(malformed)) test(`v2: malformed advisory ${name} preserves deterministic baseline`, options, async () => {
  const f = await fixture(); const host = createCurrentStateRecallHost({ enabled: true, ...f,
    advisor: { evaluate: async (...args) => corrupt(await f.advisor.evaluate(...args)) } });
  baselineOnly(await host.memory.recall(request));
  assert.equal(f.calls(), 1); assert.equal(f.reports[0].code, 'advised');
});

test('v2: report accessors are rejected without invoking their getter', options, async () => {
  const f = await fixture(); let getterCalls = 0;
  const host = createCurrentStateRecallHost({ enabled: true, ...f, advisor: { async evaluate(...args) {
    const report = { ...await f.advisor.evaluate(...args) };
    Object.defineProperty(report, 'requestDigest', { enumerable: true, get() { getterCalls++; return '0'.repeat(64); } });
    return report;
  } } });
  baselineOnly(await host.memory.recall(request)); assert.equal(getterCalls, 0); assert.equal(f.calls(), 1);
});

test('v2: a tampered envelope digest cannot become provenance by being echoed in a report', options, async () => {
  const f = await fixture(); let evaluations = 0;
  const host = createCurrentStateRecallHost({ enabled: true, ...f,
    prepareRerank: async args => ({ ...await f.prepareRerank(args), digest: 'f'.repeat(64) }),
    advisor: { async evaluate(envelope) { evaluations++; return { schemaVersion: 1, mode: 'research-shadow',
      lane: 'rerank', requestDigest: envelope.digest, code: 'advised', choice: 'alternative', authorized: false,
      memoryMutated: false, dispatched: 0, journalEntries: 0, supportChecks: 2, providerCalls: 1 }; } },
  });
  baselineOnly(await host.memory.recall(request)); assert.equal(evaluations, 0); assert.equal(f.calls(), 0);
});

for (const [name, value] of [
  ['Date', () => new Date('2026-01-01T00:00:00Z')], ['Map', () => new Map([['key', 'value']])],
  ['Set', () => new Set(['value'])], ['typed-array', () => new Uint8Array([1, 2])],
]) test(`v2: actual public preference containing ${name} fails once instead of exposing mutable internals`, options, async () => {
  const f = await fixture(); await f.documentStore.set('preferences', 'exotic-pref', gm.createPreferenceMemory({
    id: 'exotic-pref', ...coreScope, category: 'response_style', value: ['Kestrel review', value()],
    source: { method: 'explicit', extractedAt: '2026-01-01T00:00:00Z' },
  }));
  const original = await f.documentStore.get('preferences', 'exotic-pref'); const revision = f.revision(); let reads = 0;
  const host = createCurrentStateRecallHost({ enabled: true, ...f, createMemory(adapter) {
    const base = f.createMemory(adapter), recall = base.recall.bind(base);
    base.recall = input => { reads++; return recall(input); }; return base;
  } });
  await assert.rejects(host.memory.recall({ ...request, rerank: false }), unavailable);
  assert.equal(reads, 1); assert.equal(f.calls(), 0); assert.equal(f.revision(), revision);
  assert.deepEqual(await f.documentStore.get('preferences', 'exotic-pref'), original);
});

test('v2: supported nested plain values remain useful and detached, deeply immutable snapshots', options, async () => {
  const f = await fixture(); const value = ['Kestrel review', { settings: { concise: true, count: 2,
    omitted: undefined, nullish: null, labels: ['first', 'second'] } }];
  await f.documentStore.set('preferences', 'plain-pref', gm.createPreferenceMemory({
    id: 'plain-pref', ...coreScope, category: 'response_style', value,
    source: { method: 'explicit', extractedAt: '2026-01-01T00:00:00Z' },
  }));
  const host = createCurrentStateRecallHost({ enabled: true, ...f });
  const pair = await host.memory.recallAndBuildContext({ ...request, rerank: false }, { output: 'markdown', maxTokens: 1000 });
  const snapshot = pair.recall.preferences.find(p => p.id === 'plain-pref').value;
  assert.ok(Object.isFrozen(pair)); assert.ok(Object.isFrozen(snapshot[1].settings.labels));
  assert.throws(() => { snapshot[1].settings.concise = false; }, TypeError);
  assert.throws(() => snapshot[1].settings.labels.push('third'), TypeError);
  assert.throws(() => { pair.context.content = 'changed'; }, TypeError);
  assert.ok(Object.hasOwn(snapshot[1].settings, 'omitted')); assert.equal(snapshot[1].settings.omitted, undefined);
  assert.match(pair.context.content, /OLD_SENTENCE/); assert.match(pair.context.content, /Kestrel review/);
  value[1].settings.labels.push('outside');
  assert.deepEqual(snapshot[1].settings.labels, ['first', 'second']);
  assert.deepEqual((await f.documentStore.get('preferences', 'plain-pref')).value[1].settings.labels, ['first', 'second']);
  assert.equal(f.calls(), 0);
});

test('v2: unsupported request graph is rejected before any base recall or accessor invocation', options, async () => {
  const f = await fixture(); let reads = 0, getters = 0;
  const host = createCurrentStateRecallHost({ enabled: true, ...f, createMemory(adapter) {
    const base = f.createMemory(adapter), recall = base.recall.bind(base);
    base.recall = input => { reads++; return recall(input); }; return base;
  } });
  const accessor = { scope: coreScope }; Object.defineProperty(accessor, 'query', { enumerable: true,
    get() { getters++; return query; } });
  await assert.rejects(host.memory.recall(accessor), unavailable);
  await assert.rejects(host.memory.recall({ ...request, extra: new Date() }), unavailable);
  assert.equal(getters, 0); assert.equal(reads, 0); assert.equal(f.calls(), 0);
});

for (const [name, graph] of [
  ['cyclic', () => { const value = {}; value.self = value; return value; }],
  ['custom-instance', () => new (class Value { field = 'plain'; })()],
  ['bigint', () => 1n], ['non-finite-number', () => Infinity],
  ['accessor', () => Object.defineProperty({}, 'hidden', { get() { throw Error('Getter must not run.'); } })],
]) test(`v2: ${name} output graph has a static failure and no reread loop`, options, async () => {
  const f = await fixture(); let reads = 0;
  const host = createCurrentStateRecallHost({ enabled: true, ...f, createMemory(adapter) {
    const base = f.createMemory(adapter), recall = base.recall.bind(base);
    base.recall = async input => { reads++; const result = await recall(input); result.facts[0].attributes = { payload: graph() }; return result; };
    return base;
  } });
  await assert.rejects(host.memory.recall({ ...request, rerank: false }), unavailable);
  assert.equal(reads, 1); assert.equal(f.calls(), 0);
});

test('v2: unsupported constructed-context values also reject with one render', options, async () => {
  const f = await fixture(); let builds = 0;
  const host = createCurrentStateRecallHost({ enabled: true, ...f, createMemory(adapter) {
    const base = f.createMemory(adapter), build = base.buildContext.bind(base);
    base.buildContext = async input => { builds++; return { ...await build(input), extra: new Date() }; }; return base;
  } });
  const recall = await host.memory.recall({ ...request, rerank: false });
  await assert.rejects(host.memory.buildContext({ recall }), unavailable); assert.equal(builds, 1); assert.equal(f.calls(), 0);
});
