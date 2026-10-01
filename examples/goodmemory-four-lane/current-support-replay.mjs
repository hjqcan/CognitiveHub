/** Development replay against an explicit local GoodMemory package. Synthetic data/providers only. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createEnvelope, createFourLaneAdvisor, digest } from './advisor.mjs';
import { orderPlanReranker } from './adapters.mjs';
import { createSourceBoundAdvisor } from './source-gate.mjs';

const [entry, output] = process.argv.slice(2);
if (!entry || !output) throw Error('Expected GOODMEMORY_PACKAGE_ENTRY and OUTPUT_DIRECTORY.');
const { createGoodMemory, createFactMemory, createInMemoryDocumentStore, createInMemorySessionStore, createInMemoryVectorStore } =
  await import(entry.startsWith('package:') ? entry.slice(8) : pathToFileURL(resolve(entry)).href);
const scope = { tenantId: 'synthetic', userId: 'source-gate-development', workspaceId: 'observation', agentId: 'fixture', sessionId: null };
// Derived observations are durable: the public scope omits sessionId; the envelope records that dimension explicitly as null.
const coreScope = Object.fromEntries(Object.entries(scope).filter(([, value]) => value !== null));
const query = 'Tell me about the Kestrel handbook and review.';
const json = value => JSON.parse(JSON.stringify(value));
const store = createInMemoryDocumentStore();
const decisions = key => ({ name: 'synthetic-source-gate', async decide(request) {
  return { kind: 'action', candidateId: request.candidates.find(candidate => candidate.key === key)?.id ?? 'invalid', metadata: { confidence: 1 } };
} });
const options = { storage: { provider: 'memory' }, retrieval: { preset: 'recommended' }, adapters: {
  documentStore: store, sessionStore: createInMemorySessionStore(), vectorStore: createInMemoryVectorStore(),
  observationSynthesizer: { async synthesize({ contents }) { return contents.join(' '); } },
} };
const memory = createGoodMemory(options);
for (const [id, content] of [
  ['a', 'The Kestrel handbook is in the copper archive.'], ['b', 'The Kestrel review is on Monday.'],
  ['c', 'The Kestrel maintainer is Robin.'], ['d', 'The Kestrel schedule includes a quarterly review.'],
]) await store.set('facts', id, createFactMemory({ id, ...coreScope, category: 'project', subject: 'Kestrel', content,
  source: { method: 'explicit', extractedAt: '2026-01-01T00:00:00Z' } }));
await memory.runMaintenance({ scope: coreScope, jobs: ['observationSynthesis'] });
const initialExport = await memory.exportMemory({ scope: coreScope });
const summary = initialExport.durable.facts.find(fact => fact.attributes?.observationOf === 'Kestrel');
assert.ok(summary, 'Public maintenance must produce a real derived observation');
const originalBinding = digest(json(summary));
const currentRecall = () => memory.recall({ scope: coreScope, query, rerank: false });
const visibleSummary = (await currentRecall()).facts.find(fact => fact.id === summary.id);
assert.ok(visibleSummary, 'Positive prerequisite must be established');

// The record is audit data only. Membership or an explicit public suppression trace supplies the limited current-use observation.
async function inspectSummary(descriptor) {
  const result = await currentRecall();
  const current = (await memory.exportMemory({ scope: coreScope })).durable.facts.find(fact => fact.id === summary.id);
  const found = result.facts.some(fact => fact.id === summary.id && fact.content === visibleSummary.content);
  const unsupported = result.metadata.candidateTraces?.some(trace => trace.memoryId === summary.id && trace.whySuppressed === 'observation_support_unverified');
  return { status: found ? 'current' : unsupported ? 'unsupported' : 'unavailable', requestDigest: descriptor.requestDigest,
    scopeDigest: digest(scope), binding: digest(json(current ?? null)) };
}
const choices = { admission: ['admit', 'skip'], update: ['keep', 'supersede'], delete: ['retain'], rerank: ['identity', 'alternative'] };
const paired = [];
for (const stage of ['supported', 'source-revoked']) {
  if (stage === 'source-revoked') {
    const source = await store.get('facts', 'a');
    // An external fixture event, unrelated to any model choice; no deletion or model-driven mutation.
    await store.set('facts', 'a', { ...source, lifecycle: 'inactive', isActive: false });
  }
  for (const [lane, options] of Object.entries(choices)) {
    const selected = options.at(-1);
    const envelope = createEnvelope({ lane, scope, binding: originalBinding,
      facts: { target: { collection: 'facts', id: summary.id, content: visibleSummary.content }, purpose: 'Read-only evidence comparison' }, choices: [...options, 'abstain'] });
    const baseline = await createFourLaneAdvisor({ enabled: true, decision: decisions(selected) }).evaluate(envelope, {
      async readCurrentBinding() { return digest(json((await memory.exportMemory({ scope: coreScope })).durable.facts.find(fact => fact.id === summary.id) ?? null)); },
    });
    const start = performance.now();
    const gate = await createSourceBoundAdvisor({ enabled: true, decision: decisions(selected), inspectCurrent: inspectSummary }).evaluate(envelope);
    const elapsedMs = performance.now() - start;
    assert.equal(baseline.code, 'advised', 'Stable version alone does not prove current support');
    assert.equal(gate.code, stage === 'supported' ? 'advised' : 'source_unsupported');
    assert.equal(gate.providerCalls, stage === 'supported' ? 1 : 0);
    assert.equal(gate.authorized, false); assert.equal(gate.memoryMutated, false);
    assert.equal(gate.dispatched + gate.journalEntries, 0);
    paired.push({ lane, stage, baseline, gate, elapsedMs });
  }
}
const finalExport = await memory.exportMemory({ scope: coreScope });
assert.equal(digest(json(finalExport.durable.facts.find(fact => fact.id === summary.id))), originalBinding);
assert.equal(finalExport.durable.facts.find(fact => fact.id === summary.id).lifecycle, 'active');
assert.equal((await currentRecall()).facts.some(fact => fact.id === summary.id), false);
const baselineRecallIds = (await currentRecall()).facts.map(fact => fact.id);

// Real public rerank hook; a second non-reranking recall is an intentionally conservative development inspector.
const hookReports = [];
const hookWindows = [];
const reranker = { async rerank(input) {
  const snapshot = structuredClone(input);
  hookWindows.push(snapshot.documents.map(document => document.id));
  const sourceAdvisor = createSourceBoundAdvisor({ enabled: true, decision: decisions('alternative'), async inspectCurrent(descriptor) {
    const result = await memory.recall({ scope: coreScope, query: snapshot.query, rerank: false });
    // Do not duplicate private candidate rendering to manufacture a positive proof. A public representation mismatch is unavailable.
    const current = new Map(result.facts.map(fact => [fact.id, fact.content]));
    const present = snapshot.documents.every(document => current.get(document.id) === document.text);
    return { status: present ? 'current' : 'unavailable', requestDigest: descriptor.requestDigest, scopeDigest: digest(scope), binding: digest(snapshot) };
  } });
  return orderPlanReranker({ enabled: true, scope, advisor: sourceAdvisor,
    alternativeOrder: value => value.documents.map(document => document.id).reverse(), onReport: report => hookReports.push(report),
  }).rerank(input);
} };
const withHook = createGoodMemory({ ...options, adapters: { ...options.adapters, reranker } });
const result = await withHook.recall({ scope: coreScope, query });
assert.ok(hookWindows.length > 0, 'Actual public reranker must run');
assert.equal(hookWindows.flat().includes(summary.id), false, 'Core withholds unsupported summary before outbound rerank');
assert.equal(result.facts.some(fact => fact.id === summary.id), false);
assert.deepEqual(result.facts.map(fact => fact.id), baselineRecallIds, 'Unavailable support preserves deterministic recall');
assert.ok(hookReports.every(report => report.code === 'source_unavailable' && report.providerCalls === 0));
for (const report of hookReports) assert.equal(report.dispatched + report.journalEntries, 0);
await mkdir(output, { recursive: true });
await writeFile(`${output}/current-support-replay.json`, JSON.stringify({ synthetic: true, liveModelCalls: 0, actualDeletes: 0,
  paired, auditSummaryUnchangedAndActive: true, currentRecallWithholdsSummary: true, baselineRecallIds, hookWindows, hookReports,
  returnedIds: result.facts.map(fact => fact.id),
  limitations: ['Four-lane comparisons are guard evaluations on retrieved evidence, not newly integrated write/delete production hooks',
    'Delete comparison offers retain only; it adds no execution or recovery authority', 'Public recall omission alone means unavailable, not unsupported',
    'Current-source proof for arbitrary incoming writes/updates is still not a public core capability',
    'Nested recall costs up to two extra recalls and is a facts-only development inspector, not the default production integration',
    'Actual rerank support proof is unavailable here because public recall and rerank text representations differ; successful guarded real rerank coverage is zero',
    'No semantic or model-quality improvement is measured; repeated text is consumed development material'],
}, null, 2));
console.log(JSON.stringify({ pairedComparisons: paired.length, hookCalls: hookWindows.length, hookCodes: hookReports.map(report => report.code), allAssertionsPassed: true }));
