/** Explicit isolated development comparator. No real provider, key, persistence, or deletion. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createEnvelope, createFourLaneAdvisor, digest } from './advisor.mjs';
import { admissionComparator, conflictComparator, deletionEnvelope, orderPlanReranker } from './adapters.mjs';

const [entry, output] = process.argv.slice(2);
if (!entry || !output) throw new Error('Expected GOODMEMORY_ENTRY and OUTPUT_DIRECTORY.');
const { createGoodMemory, createInMemoryDocumentStore, createInMemorySessionStore, createFactMemory } = await import(
  entry.startsWith('package:') ? entry.slice(8) : pathToFileURL(resolve(entry)).href);
const actualScope = { tenantId: 'synthetic-tenant', userId: 'synthetic-four-lane', workspaceId: 'synthetic-workspace', agentId: 'synthetic-agent', sessionId: 'synthetic-session' };
const scope = { ...actualScope };
const now = () => new Date('2026-10-01T00:00:00Z');
const decide = choice => ({ name: 'deterministic-contract-fixture', async decide(request) {
  if (choice === 'abstain') return { kind: 'wait', reason: 'Fixture abstention' };
  const candidate = request.candidates.find(item => item.key === choice);
  return { kind: 'action', candidateId: candidate?.id ?? 'invalid-choice', metadata: { confidence: 1 } };
} });
const advisor = choice => { let calls = 0; const decision = decide(choice); const inner = createFourLaneAdvisor({ enabled: true, timeoutMs: 200, decision: { ...decision, async decide(...args) { calls++; return decision.decide(...args); } } }); return { ...inner, get providerCalls() { return calls; } }; };
const json = value => JSON.parse(JSON.stringify(value));
const collections = ['profiles', 'preferences', 'references', 'notes', 'facts', 'feedback', 'episodes', 'source_messages_v1', 'evidence'];
async function counts(store) { return Object.fromEntries(await Promise.all(collections.map(async name => [name, (await store.query(name)).length]))); }
function memory(store, options = {}) {
  return createGoodMemory({ storage: { provider: 'memory' }, ...options,
    adapters: { documentStore: store, sessionStore: createInMemorySessionStore(), ...options.adapters },
    testing: { now, ...options.testing } });
}
const results = { admission: [], update: [], deletion: [], rerank: [] };

for (const scenario of [
  { id: 'durable-direct', role: 'user', content: 'I prefer coffee for breakfast.' },
  { id: 'transient', role: 'user', content: 'Thanks!' },
  { id: 'assistant-personal', role: 'assistant', content: 'I prefer coffee for breakfast.' },
  { id: 'quoted-personal', role: 'user', content: 'My coworker says: "I prefer coffee for breakfast."' },
  { id: 'explicit-opt-out', role: 'user', content: 'I prefer coffee for breakfast.', annotations: [{ messageIndex: 0, remember: 'never' }] },
]) {
  const variants = [];
  for (const mode of ['baseline', 'shadow', 'synthetic-veto']) {
    const store = createInMemoryDocumentStore(); const reports = []; const model = advisor('skip');
    const input = { scope: actualScope, messages: [{ id: 'source', role: scenario.role, content: scenario.content, observedAt: '2026-01-01T00:00:00Z' }],
      ...(scenario.annotations ? { annotations: scenario.annotations } : {}) };
    const hook = admissionComparator({ enabled: mode !== 'baseline', advisor: model, mode: mode === 'baseline' ? 'shadow' : mode,
      syntheticFixture: true, onReport: report => reports.push(report),
      prepare(candidate, context) {
        const proof = { kind: 'fixture-owned-before-canonical-source-persistence', sourceHash: digest(scenario.content), sourceRole: scenario.role,
          observedAt: input.messages[0].observedAt };
        // Only post-policy candidate text is transmitted, never unredacted source text or metadata.
        const facts = { candidate: { id: candidate.id, content: candidate.content, kind: candidate.kindHint }, proof };
        const binding = digest({ facts, scope: context.scope });
        return { envelope: createEnvelope({ lane: 'admission', scope, binding, facts, choices: ['admit', 'skip', 'abstain'] }), readCurrentBinding: async () => binding };
      } });
    const result = await memory(store, { policy: { shouldRemember: hook } }).remember(input);
    variants.push({ mode, accepted: result.accepted, rejected: result.rejected, counts: await counts(store), providerCalls: model.providerCalls, policyCalls: reports.length,
      reasons: result.events.map(event => event.reason), reports });
  }
  assert.deepEqual(variants[0].counts, variants[1].counts, 'Shadow must preserve real remember baseline counts');
  assert.equal(variants[0].providerCalls, 0);
  if (scenario.id === 'durable-direct') {
    assert.ok(variants[1].providerCalls > 0); assert.equal(variants[2].counts.preferences, 0);
    assert.ok(variants[2].counts.source_messages_v1 > 0, 'Candidate veto is not a no-persistence guarantee');
  }
  results.admission.push({ id: scenario.id, variants });
}

function utcInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const normalized = value.includes('.') ? value : value.replace('Z', '.000Z'); const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === normalized ? timestamp : null;
}
for (const scenario of [
  { id: 'newer-keep', choice: 'keep', at: '2026-06-01T00:00:00Z' },
  { id: 'newer-supersede', choice: 'supersede', at: '2026-06-01T00:00:00Z' },
  { id: 'newer-abstain', choice: 'abstain', at: '2026-06-01T00:00:00Z' },
  { id: 'older-supersede-attempt', choice: 'supersede', at: '2025-06-01T00:00:00Z' },
  { id: 'equal-supersede-attempt', choice: 'supersede', at: '2026-01-01T00:00:00Z' },
  { id: 'undated-supersede-attempt', choice: 'supersede' },
]) {
  const choice = scenario.choice;
  const variants = [];
  for (const mode of ['baseline', 'shadow', 'synthetic-veto']) {
    const store = createInMemoryDocumentStore(); const reports = []; const model = advisor(choice);
    const oldPointer = 'docs/runtime-old.md'; const newPointer = 'docs/runtime-new.md';
    let changing = false;
    const hook = conflictComparator({ enabled: mode !== 'baseline', mode: mode === 'baseline' ? 'shadow' : mode, syntheticFixture: true, advisor: model,
      onReport: report => reports.push(report),
      async prepare(existing, incoming) {
        const target = { collection: 'references', id: existing.id };
        async function readContext() {
          const record = await store.get('references', existing.id);
          const evidence = (await store.query('evidence')).filter(item => item.linkedMemoryIds.includes(existing.id));
          const ids = new Set(evidence.flatMap(item => item.sourceRecordIds ?? []));
          const sources = (await store.query('source_messages_v1')).filter(item => ids.has(item.id));
          return json({ record, evidence, sources });
        }
        const previous = await readContext(); const binding = digest(previous);
        const incomingTime = utcInstant(scenario.at); const priorTimes = previous.sources.map(item => utcInstant(item.observedAt));
        const newer = incomingTime !== null && priorTimes.length > 0 && priorTimes.every(time => time !== null && incomingTime > time) && previous.sources.every(item => item.role === 'user');
        return { envelope: createEnvelope({ lane: 'update', scope, binding,
          facts: { target, previous: { pointer: existing.pointer, title: existing.title ?? null }, incoming: { content: incoming.content },
            proofKind: 'fixture-owned-incoming-clock-plus-canonical-prior-sources', incomingObservedAt: scenario.at ?? null, priorObservedAt: previous.sources.map(item => item.observedAt ?? null) }, choices: newer ? ['keep', 'supersede', 'abstain'] : ['keep', 'abstain'] }),
          readCurrentBinding: async () => digest(await readContext()) };
      } });
    const mem = memory(store, { policy: { resolveConflict: hook }, testing: { extractor: { async extract() {
      return { candidates: [{ id: 'reference-candidate', content: changing ? newPointer : oldPointer, kindHint: 'reference', explicitness: 'explicit', sourceMessageIndex: 0, sourceRole: 'user',
        metadata: { referencePointer: changing ? newPointer : oldPointer, ...(changing ? { supersedesPointer: oldPointer } : {}) } }], ignoredMessageCount: 0 };
    } } } });
    await mem.remember({ scope: actualScope, messages: [{ role: 'user', content: `Use ${oldPointer} as the source of truth for runtime work.`, observedAt: '2026-01-01T00:00:00Z' }] });
    changing = true;
    const result = await mem.remember({ scope: actualScope, messages: [{ role: 'user', content: `Correction: ${newPointer} is now the source of truth, not ${oldPointer}. Please update that.`, observedAt: scenario.at }] });
    const refs = await store.query('references');
    variants.push({ mode, accepted: result.accepted, providerCalls: model.providerCalls, policyCalls: reports.length,
      activePointers: refs.filter(record => record.lifecycle === 'active').map(record => record.pointer).sort(), reports });
  }
  assert.deepEqual(variants[0].activePointers, variants[1].activePointers);
  assert.ok(variants[1].providerCalls > 0, 'Must exercise the real resolveConflict seam');
  if (scenario.id.includes('attempt')) assert.deepEqual(variants[2].activePointers, ['docs/runtime-old.md']);
  results.update.push({ id: `reference-${scenario.id}`, variants });
}

// No call to forget/deleteAllMemory is available to this lane. Recovery is a synthetic copy simulation only.
{
  const store = createInMemoryDocumentStore(); const mem = memory(store);
  await mem.remember({ scope: actualScope, messages: [{ role: 'user', content: 'I prefer tea in the evening.', observedAt: '2026-01-01T00:00:00Z' }] });
  const [record] = await store.query('preferences'); assert.ok(record);
  async function stableExport() { const value = json(await mem.exportMemory({ scope: actualScope })); delete value.exportedAt; return value; }
  const before = await stableExport();
  const restoredCopy = structuredClone(JSON.parse(JSON.stringify(before)));
  assert.deepEqual(restoredCopy, before);
  const recoveryRecords = new Map();
  for (const collection of collections) for (const value of await store.query(collection)) recoveryRecords.set(`${collection}:${value.id}`, json(value));
  const simulator = new Map(structuredClone([...recoveryRecords]));
  assert.equal(simulator.delete(`preferences:${record.id}`), true);
  assert.equal(simulator.has(`preferences:${record.id}`), false);
  for (const [key, value] of recoveryRecords) simulator.set(key, structuredClone(value));
  assert.deepEqual([...simulator].sort(), [...recoveryRecords].sort());
  const target = { collection: 'preferences', id: record.id, recordVersion: digest(json(record)), supportVersion: digest(restoredCopy) };
  const binding = digest({ scope, target });
  for (const variant of ['missing-intent', 'wrong-target', 'missing-recovery', 'exact-proposal']) {
    const intent = variant === 'missing-intent' ? undefined : { kind: 'explicit_exact_forget', targetDigest: variant === 'wrong-target' ? digest('other') : binding };
    const recovery = variant === 'missing-recovery' ? undefined : { targetDigest: binding, snapshotDigest: digest(restoredCopy), verifiedInSyntheticSimulator: true };
    const envelope = deletionEnvelope({ scope, target, intent, recovery });
    const report = await advisor('propose_delete').evaluate(envelope, { readCurrentBinding: async () => digest({ scope, target: { ...target, recordVersion: digest(json(await store.get('preferences', record.id))), supportVersion: digest(await stableExport()) } }) });
    assert.equal(report.authorized, false); assert.equal(report.memoryMutated, false);
    assert.deepEqual(await stableExport(), before);
    if (variant !== 'exact-proposal') assert.equal(report.choice, 'abstain');
    else assert.equal(report.choice, 'propose_delete');
    results.deletion.push({ id: variant, report, actualDeletions: 0, recoveryClaim: 'Separate fixture-map removal/restore verified; not a public forget undo proof', simulatedFixtureRemovals: 1 });
  }
}

for (const variant of ['baseline', 'alternative', 'abstain', 'invalid', 'rerank-false']) {
  const store = createInMemoryDocumentStore(); const reports = []; const windows = [];
  const ranker = orderPlanReranker({ enabled: variant !== 'baseline', advisor: advisor(variant === 'abstain' ? 'abstain' : variant === 'invalid' ? 'unknown' : 'alternative'), scope,
    alternativeOrder(input) { windows.push(input.documents.map(document => document.id)); return input.documents.map(document => document.id).reverse(); },
    onReport: report => reports.push(report) });
  const mem = memory(store, { adapters: { ...(ranker ? { reranker: ranker } : {}) } });
  for (const [id, userId, content] of [
    ['a', actualScope.userId, 'Runtime migration alpha deployment checklist is ready.'],
    ['b', actualScope.userId, 'Runtime migration beta deployment checklist is ready.'],
    ['c', actualScope.userId, 'Runtime migration gamma deployment checklist is ready.'],
    ['foreign', 'different-synthetic-user', 'Runtime migration confidential external deployment checklist.'],
  ]) await store.set('facts', id, createFactMemory({ id, ...actualScope, userId, content, category: 'project', subject: id, factKind: 'project_state',
    source: { method: 'explicit', extractedAt: now().toISOString() } }, now().toISOString()));
  const result = await mem.recall({ scope: actualScope, query: 'runtime migration deployment checklist', ...(variant === 'rerank-false' ? { rerank: false } : {}) });
  assert.equal(result.facts.some(fact => fact.id === 'foreign'), false);
  assert.equal(windows.flat().includes('foreign'), false);
  if (['baseline', 'rerank-false'].includes(variant)) assert.equal(reports.length, 0);
  else assert.ok(reports.length > 0, 'Must exercise the real public recall reranker');
  results.rerank.push({ id: variant, returnedIds: result.facts.map(fact => fact.id), windows, reports,
    trace: result.metadata.retrievalTrace?.reranker ?? null });
}
for (const group of Object.values(results)) for (const row of group) {
  const reports = row.variants?.flatMap(variant => variant.reports) ?? row.reports ?? [row.report];
  for (const report of reports) if (report) assert.deepEqual([report.dispatched, report.journalEntries], [0, 0]);
}
await mkdir(output, { recursive: true });
await writeFile(`${output}/development-replay.json`, JSON.stringify({ synthetic: true, liveModelCalls: 0, results,
  limitations: ['No production automatic activation', 'Deletion is proposal-only and copy simulation is not real undo', 'No live Jev semantic quality measurement',
    'Admission policy hook lacks canonical persisted source records', 'Conflict example covers references only; preference uses separate existing shadow',
    'Reranker covers only existing public eligible durable pools; order-plan selection is constrained'] }, null, 2));
console.log(JSON.stringify({ cases: Object.fromEntries(Object.entries(results).map(([lane, cases]) => [lane, cases.length])),
  liveModelCalls: 0, actualDeletionCalls: 0, realPublicPipelines: ['remember', 'resolveConflict', 'recall', 'exportMemory'] }, null, 2));
