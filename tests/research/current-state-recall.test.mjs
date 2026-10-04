import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { entry, gm, fixture, baselineReranker, deferred, scope, coreScope, query, oldText, newText } from './current-state-fixture.mjs';

const recallInput = { scope: coreScope, query };
const options = { skip: !entry };
const load = () => import('../../examples/goodmemory-four-lane/current-state-recall.mjs');

test('baseline: trusted source postcheck still leaves ordinary stale fallback and prompt', options, async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ transport: async () => { entered.resolve(); await release.promise; return new Response('', { status: 503 }); } });
  const memory = f.createMemory(baselineReranker(f));
  const pending = memory.recall(recallInput);
  await entered.promise; await f.update(); release.resolve();
  const recalled = await pending;
  assert.ok(recalled.facts.some(fact => fact.content === oldText));
  assert.equal((await f.documentStore.get('facts', 'a')).content, newText);
  const context = await memory.buildContext({ recall: recalled, output: 'system_prompt_fragment' });
  assert.match(context.content, /OLD_SENTENCE/);
  assert.doesNotMatch(context.content, /NEW_SENTENCE/);
  assert.equal(f.calls(), 1);
  assert.equal(f.reports[0].supportChecks, 2);
  assert.equal(f.reports[0].code, 'stale');
  assert.equal(f.reports[0].memoryMutated, false);
});

test('candidate: disabled constructor inspects no dependencies', options, async () => {
  const { createCurrentStateRecallHost } = await load();
  const disabled = { enabled: false };
  for (const name of ['createMemory', 'readCurrent', 'advisor', 'prepareRerank']) {
    Object.defineProperty(disabled, name, { get() { throw Error('Disabled dependency inspected.'); } });
  }
  assert.deepEqual(createCurrentStateRecallHost(undefined), { enabled: false });
  assert.deepEqual(createCurrentStateRecallHost(disabled), { enabled: false });
});

test('candidate: real reranker permits a source-checked finite alternative plan', options, async () => {
  const { createCurrentStateRecallHost } = await load();
  const f = await fixture();
  const revisionBeforeReads = f.revision();
  const baseline = await f.createMemory().recall(recallInput);
  const host = createCurrentStateRecallHost({ enabled: true, ...f });
  const result = await host.memory.recall(recallInput);
  assert.equal(f.calls(), 1);
  assert.equal(f.reports[0].code, 'advised');
  assert.deepEqual(new Set(result.facts.map(fact => fact.id)), new Set(baseline.facts.map(fact => fact.id)));
  assert.deepEqual(result.facts.map(fact => fact.id), baseline.facts.map(fact => fact.id).reverse());
  assert.equal(f.reports[0].authorized, false);
  assert.equal(f.reports[0].memoryMutated, false);
  assert.equal(f.reports[0].dispatched + f.reports[0].journalEntries, 0);
  assert.equal(f.revision(), revisionBeforeReads, 'Positive public recalls did not cause tracked self-writes.');
});

for (const response of ['failure', 'success']) test(`candidate: concurrent update during ${response} refreshes the entire fallback`, options, async () => {
  const { createCurrentStateRecallHost } = await load();
  const entered = deferred(), release = deferred();
  const f = await fixture({ transport: async body => {
    entered.resolve(); await release.promise;
    if (response === 'failure') return new Response('', { status: 503 });
    const probabilities = Object.fromEntries(Object.keys(body.questions.next.criteria).map(key => [key, +(key === 'c1')]));
    return Response.json({ model: 'jev-fixture', answers: { next: { type: 'choice', choice: 'c1', probabilities, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 0 } });
  } });
  const host = createCurrentStateRecallHost({ enabled: true, ...f });
  const pending = host.memory.recall(recallInput);
  await entered.promise; await f.update(); release.resolve();
  const result = await pending;
  assert.ok(result.facts.some(fact => fact.content === newText));
  assert.ok(!result.facts.some(fact => fact.content === oldText));
  const context = await host.memory.buildContext({ recall: result, output: 'system_prompt_fragment' });
  assert.match(context.content, /NEW_SENTENCE/); assert.doesNotMatch(context.content, /OLD_SENTENCE/);
  assert.equal(f.calls(), 1, 'Fresh fallback does not repeat the advisory request.');
});

test('candidate: buildContext re-reads an issued stale snapshot without new advice', options, async () => {
  const { createCurrentStateRecallHost } = await load();
  const f = await fixture(); const host = createCurrentStateRecallHost({ enabled: true, ...f });
  const before = await host.memory.recall(recallInput);
  await f.update();
  const context = await host.memory.buildContext({ recall: before, output: 'system_prompt_fragment' });
  assert.match(context.content, /NEW_SENTENCE/); assert.doesNotMatch(context.content, /OLD_SENTENCE/);
  assert.equal(f.calls(), 1);
  assert.ok(before.facts.some(fact => fact.content === oldText), 'Previously returned object remains a snapshot.');
  await assert.rejects(host.memory.buildContext({ recall: structuredClone(before) }), { code: 'current_state_unavailable' });
});

test('candidate: unavailable source proof skips HTTP and preserves stable baseline', options, async () => {
  const { createCurrentStateRecallHost } = await load();
  const f = await fixture({ allowed: false }); const host = createCurrentStateRecallHost({ enabled: true, ...f });
  const result = await host.memory.recall(recallInput);
  assert.equal(f.calls(), 0); assert.equal(f.reports[0].code, 'source_unavailable');
  assert.ok(result.facts.some(fact => fact.content === oldText));
});

test('candidate: explicit rerank false and diagnosis still get state fencing with zero HTTP', options, async () => {
  const { createCurrentStateRecallHost } = await load();
  const f = await fixture(); const host = createCurrentStateRecallHost({ enabled: true, ...f });
  assert.ok((await host.memory.recall({ ...recallInput, rerank: false })).facts.length);
  const diagnostic = await host.memory.diagnoseRecall(recallInput);
  assert.ok(diagnostic.facts.length); assert.equal(f.calls(), 0);
});

test('candidate: unknown scope receipts and continuously changing state fail closed', options, async () => {
  const { createCurrentStateRecallHost } = await load();
  const f = await fixture();
  const wrong = createCurrentStateRecallHost({ enabled: true, ...f,
    readCurrent: async () => ({ status: 'current', scopeDigest: 'a'.repeat(64), revision: '1', stable: true }) });
  await assert.rejects(wrong.memory.recall(recallInput), { code: 'current_state_unavailable' });
  let revision = 0;
  const unstable = createCurrentStateRecallHost({ enabled: true, ...f, readCurrent: async scope => {
    const { digest } = await import('../../examples/goodmemory-four-lane/advisor.mjs');
    return { status: 'current', scopeDigest: digest(scope), revision: String(++revision), stable: true };
  } });
  await assert.rejects(unstable.memory.recall({ ...recallInput, rerank: false }), { code: 'current_state_unavailable' });
  assert.equal(f.calls(), 0);
});

test('baseline: buildContext trusts a packet captured before a later update', options, async () => {
  const f = await fixture(); const memory = f.createMemory();
  const before = await memory.recall({ ...recallInput, rerank: false });
  await f.update();
  assert.match((await memory.buildContext({ recall: before, output: 'system_prompt_fragment' })).content, /OLD_SENTENCE/);
  assert.equal(f.calls(), 0);
});

test('candidate: reference and non-reranked preference/note/profile/feedback changes refresh the whole packet', options, async () => {
  const { createCurrentStateRecallHost } = await load();
  const entered = deferred(), release = deferred();
  const f = await fixture({ transport: async () => { entered.resolve(); await release.promise; return new Response('', { status: 503 }); } });
  const source = { method: 'explicit', extractedAt: '2026-01-01T00:00:00Z' };
  await f.documentStore.set('references', 'r', gm.createReferenceMemory({ id: 'r', ...coreScope,
    title: 'Kestrel review OLD_REFERENCE', pointer: 'docs/kestrel-review.md', source }));
  f.approve('references', 'r');
  await f.documentStore.set('preferences', 'p', gm.createPreferenceMemory({ id: 'p', ...coreScope,
    category: 'response_style', value: 'Kestrel review OLD_PREFERENCE', source }));
  await f.documentStore.set('notes', 'n', gm.createNoteMemory({ id: 'n', ...coreScope,
    title: 'Kestrel review note', body: 'Kestrel review OLD_NOTE', source }));
  await f.documentStore.set('feedback', 'fb', gm.createFeedbackMemory({ id: 'fb', ...coreScope,
    kind: 'do', rule: 'Kestrel review OLD_FEEDBACK', source }));
  await f.documentStore.set('profiles', coreScope.userId, gm.createUserProfile({ ...coreScope,
    identity: { name: 'OLD_PROFILE' } }));
  const baseline = await f.createMemory().recall({ ...recallInput, rerank: false });
  assert.ok(baseline.preferences.some(record => record.value.includes('OLD_PREFERENCE')));
  assert.ok(baseline.notes.some(record => record.body.includes('OLD_NOTE')));
  assert.ok(baseline.feedback.some(record => record.rule.includes('OLD_FEEDBACK')));
  assert.equal(baseline.profile.identity.name, 'OLD_PROFILE');
  const host = createCurrentStateRecallHost({ enabled: true, ...f });
  const pending = host.memory.recall(recallInput);
  await entered.promise;
  await Promise.all([
    f.update(),
    f.documentStore.update('references', 'r', { title: 'Kestrel review NEW_REFERENCE' }),
    f.documentStore.update('preferences', 'p', { value: 'Kestrel review NEW_PREFERENCE' }),
    f.documentStore.update('notes', 'n', { body: 'Kestrel review NEW_NOTE' }),
    f.documentStore.update('feedback', 'fb', { rule: 'Kestrel review NEW_FEEDBACK' }),
    f.documentStore.update('profiles', coreScope.userId, { identity: { name: 'NEW_PROFILE' } }),
  ]);
  release.resolve(); const recalled = await pending;
  assert.ok(recalled.references.some(record => record.title.includes('NEW_REFERENCE')));
  assert.ok(recalled.preferences.some(record => record.value.includes('NEW_PREFERENCE')));
  assert.ok(recalled.notes.some(record => record.body.includes('NEW_NOTE')));
  assert.ok(recalled.feedback.some(record => record.rule.includes('NEW_FEEDBACK')));
  assert.equal(recalled.profile.identity.name, 'NEW_PROFILE');
  const built = await host.memory.buildContext({ recall: recalled, output: 'system_prompt_fragment' });
  assert.doesNotMatch(built.content, /OLD_(SENTENCE|REFERENCE|PREFERENCE|NOTE|FEEDBACK|PROFILE)/);
  assert.equal(f.calls(), 1);
});

test('candidate: combined recall/context returns a coherent pair when context construction races an update', options, async () => {
  const { createCurrentStateRecallHost } = await load();
  const f = await fixture(); let builds = 0;
  const host = createCurrentStateRecallHost({ enabled: true, ...f, createMemory(reranker) {
    const memory = f.createMemory(reranker); const build = memory.buildContext.bind(memory);
    memory.buildContext = async input => { if (builds++ === 0) await f.update(); return build(input); };
    return memory;
  } });
  const pair = await host.memory.recallAndBuildContext(recallInput, { output: 'system_prompt_fragment' });
  assert.ok(pair.recall.facts.some(fact => fact.content === newText));
  assert.match(pair.context.content, /NEW_SENTENCE/); assert.doesNotMatch(pair.context.content, /OLD_SENTENCE/);
  assert.equal(f.calls(), 1); assert.equal(builds, 2);
});

test('candidate: a one-document window uses stable baseline without advisory HTTP', options, async () => {
  const { createCurrentStateRecallHost } = await load(); const f = await fixture();
  await f.documentStore.delete('facts', 'b');
  const host = createCurrentStateRecallHost({ enabled: true, ...f });
  const recalled = await host.memory.recall(recallInput);
  assert.equal(recalled.facts.length, 1); assert.equal(f.calls(), 0);
});

test('candidate: detached raw reranker lacks caller scope and cannot send data', options, async () => {
  const { createCurrentStateRecallHost } = await load(); const f = await fixture(); let reranker;
  createCurrentStateRecallHost({ enabled: true, ...f, createMemory(adapter) { reranker = adapter; return f.createMemory(adapter); } });
  await assert.rejects(reranker.rerank({ query, documents: [{ id: 'a', text: oldText }, { id: 'b', text: 'Kestrel review' }] }), { code: 'current_state_unavailable' });
  assert.equal(f.calls(), 0);
});

test('candidate: self-writing verification-pressure recalls conservatively fail closed', options, async () => {
  const { createCurrentStateRecallHost } = await load(); const f = await fixture({ now: '2026-10-04T00:00:00Z' });
  const host = createCurrentStateRecallHost({ enabled: true, ...f });
  await assert.rejects(host.memory.recall({ ...recallInput, rerank: false }), { code: 'current_state_unavailable' });
  assert.ok(f.mutations.some(change => change.collection === 'facts' && change.operation === 'writeBatchIfUnchanged'));
  assert.equal(f.calls(), 0);
});

test('candidate: deadlines retain the original advisor physical slot and busy requests use stable baseline', options, async () => {
  const { createCurrentStateRecallHost } = await load(); const entered = deferred(), release = deferred();
  const f = await fixture({ transport: async () => { entered.resolve(); await release.promise; return new Response('', { status: 503 }); } });
  const host = createCurrentStateRecallHost({ enabled: true, ...f, timeoutMs: 40 });
  const pending = host.memory.recall(recallInput);
  await entered.promise; await assert.rejects(pending, { code: 'current_state_unavailable' });
  const next = await host.memory.recall(recallInput);
  assert.ok(next.facts.length); assert.equal(f.calls(), 1);
  assert.ok(f.reports.some(report => report.code === 'busy'));
  release.resolve(); await new Promise(resolve => setTimeout(resolve, 10));
});

test('candidate: cancelled calls, foreign scopes and foreign plans never transmit', options, async () => {
  const { createCurrentStateRecallHost } = await load(); const f = await fixture();
  const host = createCurrentStateRecallHost({ enabled: true, ...f });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(host.memory.recall(recallInput, { signal: controller.signal }), { code: 'current_state_unavailable' });
  await assert.rejects(host.memory.recall({ ...recallInput, scope: { ...coreScope, workspaceId: 'foreign' } }), { code: 'current_state_unavailable' });
  const foreign = createCurrentStateRecallHost({ enabled: true, ...f, alternativeOrder: () => ['a', 'foreign'] });
  const result = await foreign.memory.recall(recallInput);
  assert.deepEqual(new Set(result.facts.map(fact => fact.id)), new Set(['a', 'b']));
  assert.equal(f.calls(), 0);
});

test('candidate: overlapping callers keep complete scope isolated; busy advice never mixes data', options, async () => {
  const { createCurrentStateRecallHost } = await load(); const entered = deferred(), release = deferred();
  const f = await fixture({ transport: async body => {
    entered.resolve(); await release.promise;
    const probabilities = Object.fromEntries(Object.keys(body.questions.next.criteria).map(key => [key, +(key === 'c1')]));
    return Response.json({ model: 'jev-fixture', answers: { next: { type: 'choice', choice: 'c1', probabilities, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 0 } });
  } });
  const otherScope = { ...scope, userId: 'synthetic-other', workspaceId: 'other-workspace' };
  f.allowScope(otherScope);
  for (const id of ['other-a', 'other-b']) {
    const durable = Object.fromEntries(Object.entries(otherScope).filter(([, value]) => value !== null));
    await f.documentStore.set('facts', id, gm.createFactMemory({ id, ...durable, category: 'project',
      subject: 'Kestrel', content: 'Kestrel review OTHER_SCOPE', source: { method: 'explicit', extractedAt: '2026-01-01T00:00:00Z' } }));
    f.approve('facts', id);
  }
  const host = createCurrentStateRecallHost({ enabled: true, ...f });
  const first = host.memory.recall(recallInput); await entered.promise;
  const other = await host.memory.recall({ scope: Object.fromEntries(Object.entries(otherScope).filter(([, value]) => value !== null)), query });
  assert.ok(other.facts.every(fact => fact.userId === otherScope.userId));
  assert.ok(f.preparedScopes.some(prepared => prepared.scope.userId === otherScope.userId && prepared.ids.every(id => id.startsWith('other-'))));
  assert.doesNotMatch(JSON.stringify(f.bodies), /synthetic-other|OTHER_SCOPE/);
  assert.equal(f.calls(), 1); release.resolve();
  assert.ok((await first).facts.every(fact => fact.userId === scope.userId));
});

for (const mutation of ['delete', 'deactivate', 'invalidate']) test(`candidate: ${mutation} during advisory fallback cannot reappear in context`, options, async () => {
  const { createCurrentStateRecallHost } = await load(); const entered = deferred(), release = deferred();
  const f = await fixture({ transport: async () => { entered.resolve(); await release.promise; return new Response('', { status: 503 }); } });
  const host = createCurrentStateRecallHost({ enabled: true, ...f });
  const pending = host.memory.recall(recallInput); await entered.promise;
  if (mutation === 'delete') await f.documentStore.delete('facts', 'a');
  else if (mutation === 'deactivate') await f.documentStore.update('facts', 'a', { lifecycle: 'inactive', isActive: false });
  else await f.documentStore.update('facts', 'a', { lifecycle: 'invalidated', isActive: false });
  release.resolve(); const recalled = await pending;
  assert.ok(!recalled.facts.some(record => record.id === 'a'));
  assert.doesNotMatch((await host.memory.buildContext({ recall: recalled, output: 'system_prompt_fragment' })).content, /OLD_SENTENCE/);
  assert.equal(f.calls(), 1);
});

test('candidate: independently source-approved redaction removes private text before fake HTTP', options, async () => {
  const { createCurrentStateRecallHost } = await load();
  const f = await fixture({ redact: value => JSON.parse(JSON.stringify(value).replaceAll('PRIVATE_SENTINEL', 'REDACTED')) });
  await f.documentStore.update('facts', 'a', { content: `${oldText} PRIVATE_SENTINEL` });
  const host = createCurrentStateRecallHost({ enabled: true, ...f });
  const result = await host.memory.recall({ ...recallInput, query: `${query} PRIVATE_SENTINEL` });
  assert.equal(f.calls(), 1); assert.equal(f.reports[0].code, 'advised');
  assert.doesNotMatch(JSON.stringify(f.bodies), /PRIVATE_SENTINEL/);
  assert.match(JSON.stringify(f.bodies), /REDACTED/);
  assert.ok(result.facts.some(record => record.content.includes('PRIVATE_SENTINEL')), 'Redaction does not rewrite canonical memory.');
});

test('real Runtime Kit seam: fresh fragment can accompany its retained stale recall snapshot', options, async () => {
  const { createCurrentStateRecallHost } = await load();
  const { createGoodMemoryRuntimeKit } = await import(new URL('./runtime-kit/index.ts', pathToFileURL(entry)).href);
  const f = await fixture();
  const host = createCurrentStateRecallHost({ enabled: true, ...f });
  const memory = new Proxy(host.memory, { get(target, key) {
    if (key === 'recall') return async input => { const result = await target.recall(input); await f.update(); return result; };
    return Reflect.get(target, key);
  } });
  const result = await createGoodMemoryRuntimeKit({ memory }).beforeModelCall({
    ...recallInput, referenceTime: '2026-01-02T00:00:00Z', maxMemoryTokens: 1000,
  });
  assert.match(result.context.content, /NEW_SENTENCE/); assert.doesNotMatch(result.context.content, /OLD_SENTENCE/);
  assert.ok(result.recall.facts.some(record => record.content === oldText));
  assert.equal(f.calls(), 1);
  // This is explicit evidence that this caller needs migration to the coherent-pair method.
  // Runtime Kit's feedback steering/raw carryover remains outside the facade's final fence.
});
