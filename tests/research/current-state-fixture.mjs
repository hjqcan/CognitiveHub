import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createConfiguredSourceBoundAdvisor } from '../../examples/goodmemory-four-lane/configured-advisor.mjs';
import { createEnvelope, digest } from '../../examples/goodmemory-four-lane/advisor.mjs';

export const entry = process.env.GOODMEMORY_RESEARCH_ENTRY;
// No ambient model/network fallback is allowed in this synthetic seam suite.
globalThis.fetch = async () => { throw new Error('Ambient network disabled in research fixture.'); };
export const gm = entry ? await import(pathToFileURL(entry).href) : null;
export const scope = Object.freeze({ userId: 'synthetic-reader', tenantId: 'synthetic-tenant',
  workspaceId: 'synthetic-workspace', agentId: 'synthetic-agent', sessionId: null });
export const coreScope = Object.fromEntries(Object.entries(scope).filter(([, value]) => value !== null));
export const query = 'Kestrel review';
export const oldText = 'Kestrel review is on Monday OLD_SENTENCE';
export const newText = 'Kestrel review is on Tuesday NEW_SENTENCE';
export function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const words = text => new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
const json = value => JSON.parse(JSON.stringify(value));

export async function fixture({ transport, allowed = true, timeoutMs = 1000, now = '2026-01-02T00:00:00Z', scope: ownedScope = scope,
  redact = value => value } = {}) {
  assert.ok(gm, 'Set GOODMEMORY_RESEARCH_ENTRY to an explicit built/source entry.');
  let revision = 0, pending = 0, transportCalls = 0;
  const mutations = [];
  const mutate = (callback, operation) => async (...args) => {
    mutations.push({ operation, collection: typeof args[0] === 'string' ? args[0] : args[0]?.expected?.collection ?? 'session-or-vector' });
    revision++; pending++;
    try { return await callback(...args); } finally { pending--; revision++; }
  };
  const instrument = (store, mutationNames) => new Proxy(store, { get(target, key) {
    const method = target[key];
    if (typeof method !== 'function') return method;
    if (key === 'writeBatchIfUnchanged') return input =>
      input.set.length || input.delete?.length ? mutate(method.bind(target), key)(input) : method.call(target, input);
    return mutationNames.includes(key) ? mutate(method.bind(target), key) : method.bind(target);
  } });
  const documentStore = instrument(gm.createInMemoryDocumentStore(), ['set', 'update', 'delete']);
  const sessionStore = instrument(gm.createInMemorySessionStore(), ['saveBuffer', 'saveBufferIfUnchanged', 'deleteBufferIfUnchanged',
    'saveWorkingMemory', 'saveJournal', 'deleteBuffersByScope', 'deleteWorkingMemoryByScope',
    'deleteJournalsByScope', 'recoverLegacyState']);
  const vectorStore = instrument(gm.createInMemoryVectorStore(), ['upsert', 'delete']);
  const ownedCoreScope = Object.fromEntries(Object.entries(ownedScope).filter(([, value]) => value !== null));
  const ownedScopes = new Map([[digest(ownedScope), Object.freeze(json(ownedScope))]]);
  const approvedSources = new Map([['facts:a', { collection: 'facts', id: 'a' }], ['facts:b', { collection: 'facts', id: 'b' }]]);
  for (const [id, content] of [['a', oldText], ['b', 'Kestrel review handbook is in the copper archive']]) {
    await documentStore.set('facts', id, gm.createFactMemory({ id, ...ownedCoreScope, subject: 'Kestrel',
      category: 'project', content, source: { method: 'explicit', extractedAt: '2026-01-01T00:00:00Z' } }));
  }
  const bodies = [], reports = [], preparedScopes = [], approved = new Map();
  const readCurrent = async requested => ({ status: ownedScopes.has(digest(requested)) ? 'current' : 'unavailable',
    scopeDigest: ownedScopes.has(digest(requested)) ? digest(requested) : digest(ownedScope), revision: String(revision), stable: pending === 0 });
  // An independent fixture host owns both the canonical records and a source approval set.
  // Text is checked against canonical source vocabulary BEFORE redaction, not against descriptor hashes.
  const prepareRerank = async ({ input, plans, scope: requested, state }) => {
    const approvedScope = ownedScopes.get(digest(requested));
    assert.ok(approvedScope); assert.deepEqual(requested, approvedScope);
    preparedScopes.push({ scope: requested, ids: input.documents.map(document => document.id) });
    const records = [], sources = [];
    for (const document of input.documents) {
      const matches = [...approvedSources.values()].filter(source => document.id === source.id || document.id === `${source.collection}:${source.id}`);
      assert.equal(matches.length, 1, 'Independent approval set must identify one canonical source.');
      const source = matches[0];
      const record = await documentStore.get(source.collection, source.id);
      assert.ok(record && record.source.method === 'explicit' && record.lifecycle === 'active' && record.isActive !== false);
      assert.ok(!record.attributes?.observationOf, 'Fixture inspector does not approve derived observations.');
      for (const [key, value] of Object.entries(approvedScope)) assert.equal(record[key] ?? null, value);
      const sourceWords = words([record.content, record.subject, record.title, record.description, record.pointer,
        record.summary, ...(record.topics ?? []), ...(record.keyDecisions ?? []), ...(record.unresolvedItems ?? [])].filter(Boolean).join(' '));
      assert.ok([...words(document.text)].every(word => sourceWords.has(word)), 'Text must be attributable to canonical source.');
      records.push(json(record));
      sources.push(source);
    }
    const facts = { ...redact({ query: input.query, documents: input.documents }), plans };
    const binding = digest({ scope: approvedScope, revision: state.revision, records, facts });
    const envelope = createEnvelope({ lane: 'rerank', scope: approvedScope, binding, facts, choices: ['identity', 'alternative', 'abstain'] });
    approved.set(envelope.digest, { records, sources, facts, scope: approvedScope, revision: state.revision });
    return envelope;
  };
  const configured = createConfiguredSourceBoundAdvisor({ enabled: true, apiKeyEnv: 'SYNTHETIC_FIXTURE_KEY',
    model: 'jev-fixture', endpoint: 'https://synthetic.invalid/v1/systemone', timeoutMs }, {
    readEnv: () => 'synthetic-fixture-literal',
    async fetch(_url, init) {
      transportCalls++;
      const body = JSON.parse(init.body); bodies.push(body);
      if (transport) return transport(body, init);
      const probabilities = Object.fromEntries(Object.keys(body.questions.next.criteria).map(key => [key, +(key === 'c1')]));
      return Response.json({ model: 'jev-fixture', answers: { next: { type: 'choice', choice: 'c1', probabilities, confidence: 1 } },
        usage: { input_tokens: 1, output_tokens: 0 } });
    },
    async inspectCurrent(descriptor) {
      const proof = approved.get(descriptor.requestDigest);
      assert.ok(proof);
      assert.deepEqual(descriptor.scope, proof.scope);
      const records = json(await Promise.all(proof.sources.map(source => documentStore.get(source.collection, source.id))));
      const usable = allowed && pending === 0 && records.every(record => record?.lifecycle === 'active' && record.isActive !== false &&
        Object.entries(proof.scope).every(([key, value]) => (record[key] ?? null) === value));
      return { status: usable ? 'current' : 'unavailable', requestDigest: descriptor.requestDigest,
        scopeDigest: digest(proof.scope), binding: digest({ scope: proof.scope, revision: String(revision), records, facts: proof.facts }) };
    },
  });
  const advisor = { async evaluate(...args) { const report = await configured.advisor.evaluate(...args); reports.push(report); return report; } };
  const createMemory = reranker => gm.createGoodMemory({ storage: { provider: 'memory' },
    testing: { now: () => new Date(now) },
    adapters: { documentStore, sessionStore, vectorStore, ...(reranker ? { reranker } : {}) } });
  return { documentStore, sessionStore, vectorStore, createMemory, readCurrent, prepareRerank, advisor,
    alternativeOrder: input => input.documents.map(document => document.id).reverse(),
    bodies, reports, mutations, preparedScopes, calls: () => transportCalls, revision: () => revision,
    approve: (collection, id) => { revision += 2; approvedSources.set(`${collection}:${id}`, { collection, id }); },
    allowScope: requested => { revision += 2; ownedScopes.set(digest(requested), Object.freeze(json(requested))); },
    update: () => documentStore.update('facts', 'a', { content: newText, updatedAt: '2026-01-02T00:00:00Z' }),
  };
}

export function baselineReranker(f) {
  return { async rerank(input) {
    const state = await f.readCurrent(scope);
    const identity = input.documents.map(document => document.id);
    const alternative = await f.alternativeOrder(input);
    const envelope = await f.prepareRerank({ input, scope, state, plans: { identity, alternative } });
    const report = await f.advisor.evaluate(envelope);
    if (report.code !== 'advised') throw new Error('Synthetic source-bound advice unavailable.');
    const ids = report.choice === 'alternative' ? alternative : identity;
    return ids.map((id, index) => ({ id, score: ids.length - index }));
  } };
}
