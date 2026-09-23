import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareAdvice, MemoryDecisionStore } from '../dist/index.js';
import { boot, createPlatform, spec } from './runtime-host.mjs';

// Advisory runs shadow a host that keeps doing the real work: they propose and preview, never claim or dispatch.

const advisory = (changes = {}) => spec({ approval: 'advisory', intent: { ...spec().intent, id: 'advice' }, ...changes });

test('an advisory run proposes and previews but never claims, reserves or dispatches', async () => {
  const decisions = new MemoryDecisionStore();
  const platform = createPlatform(); platform.info = 'given';
  const { runtime, events } = await boot(platform, { decisions });
  const shadow = await runtime.start(advisory());
  const advised = await runtime.step(shadow.id);
  assert.equal(advised.outcome, 'advised'); assert.equal(advised.code, undefined); assert.ok(advised.decisionId);
  assert.equal(advised.recordId, undefined); assert.deepEqual(advised.run.operations, []);
  assert.equal(advised.run.status, 'waiting'); assert.deepEqual(advised.run.wait.map(c => c.kind), ['state', 'time']);
  assert.equal(advised.run.counters.actions, 0); assert.equal(advised.run.lease, null);
  assert.equal(platform.submissions, 0); assert.equal(runtime.hub.journal.entries().length, 0);
  const record = await decisions.get(advised.decisionId);
  assert.deepEqual([record.outcome, record.recordId], ['proposal', null]);
  assert.ok(events.entries().some(e => e.type === 'run.advised' && e.data.preview === null));
  // The same resource stays free for the run that really acts.
  const actor = await runtime.start(spec());
  assert.equal((await runtime.step(actor.id)).outcome, 'waiting');
  assert.equal(platform.submissions, 1); assert.equal(runtime.hub.journal.entries().length, 1);
});

test('a preview the host would refuse is recorded as the step code', async () => {
  const platform = createPlatform(); platform.info = 'given';
  const policy = { async check({ phase }) { return { allowed: phase === 'propose', version: 'p', reason: 'dispatch is not authorized' }; } };
  const { runtime } = await boot(platform, { policy });
  const shadow = await runtime.start(advisory());
  const refused = await runtime.step(shadow.id);
  assert.deepEqual([refused.outcome, refused.code], ['advised', 'policy-rejected']);
  assert.equal(platform.submissions, 0);
});

test('a quiet host costs an advisory run no decisions and no no-progress, until the deadline', async () => {
  const platform = createPlatform(); platform.info = 'given';
  const { runtime, clock } = await boot(platform);
  const deadlineAt = clock.now + 200_000;
  const shadow = await runtime.start(advisory({ waitMs: 50_000, budget: { maxDecisions: 10, maxActions: 1, maxNoProgress: 1, deadlineAt } }));
  const first = await runtime.step(shadow.id);
  assert.equal(first.outcome, 'advised'); assert.equal(first.run.counters.decisions, 1);
  for (let i = 0; i < 3; i++) {
    clock.now = (await runtime.get(shadow.id)).wait.find(c => c.kind === 'time').at;
    const rearmed = await runtime.step(shadow.id);
    assert.equal(rearmed.outcome, 'waiting');
    assert.deepEqual([rearmed.run.counters.decisions, rearmed.run.counters.noProgress], [1, 0]);
  }
  platform.info = 'changed';                                    // the state moves: advise again
  const again = await runtime.step(shadow.id);
  assert.equal(again.outcome, 'advised'); assert.equal(again.run.counters.decisions, 2);
  clock.now = deadlineAt + 1;
  const ended = await runtime.step(shadow.id);
  assert.equal(ended.outcome, 'deliberating'); assert.equal(ended.run.request.kind, 'budget');
  assert.equal(platform.submissions, 0);
});

test('approval modes are validated', async () => {
  const { runtime } = await boot(createPlatform());
  await assert.rejects(runtime.start(spec({ approval: 'shadow' })), { code: 'invalid-run' });
});

const candidate = (capability, key) => ({ id: JSON.stringify([capability, key]), capability, key });
const record = (id, candidates, choice) => ({ id, request: candidates.length ? { candidates } : null,
  decision: choice === null ? null : choice === 'wait' ? { kind: 'wait', reason: 'hold' } : { kind: 'action', candidateId: choice.id } });

test('compareAdvice separates agreement, the decider\'s misses and the adapters\' misses', () => {
  const reroute = candidate('recover@1', 'reroute'), retry = candidate('recover@1', 'retry');
  const records = [
    record('agree', [reroute, retry], reroute),
    record('differ', [reroute, retry], reroute),
    record('abstain', [reroute], 'wait'),
    record('overreach', [retry], retry),
    record('quiet', [retry], 'wait'),
    record('missing', [], null),
  ];
  const labels = [
    { decisionId: 'agree', actual: { capability: 'recover@1', key: 'reroute' } },
    { decisionId: 'differ', actual: { capability: 'recover@1', key: 'retry' } },
    { decisionId: 'abstain', actual: { capability: 'recover@1', key: 'reroute' } },
    { decisionId: 'overreach', actual: null },
    { decisionId: 'quiet', actual: null },
    { decisionId: 'missing', actual: { capability: 'maintenance@1', key: 'call' } },
    { decisionId: 'never-recorded', actual: null },
  ];
  const c = compareAdvice(records, labels);
  assert.deepEqual({ ...c, missing: c.missing.map(m => m.decisionId) }, {
    labelled: 6, agreed: 2, agreement: 2 / 6, recall: 3 / 4, differed: 1, abstained: 2, overreach: 1,
    missing: ['missing'], unmatched: ['never-recorded'] });
  assert.deepEqual(compareAdvice([], []), { labelled: 0, agreed: 0, agreement: null, recall: null, differed: 0, abstained: 0,
    overreach: 0, missing: [], unmatched: [] });
});

test('the shadow example and the replay CLI report the same comparison, offline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cognitive-hub-shadow-'));
  const output = execFileSync(process.execPath, ['examples/shadow-advisor.mjs', dir], { encoding: 'utf8' });
  assert.match(output, /Advised: 5 of 6 incidents/); assert.match(output, /Dispatched: 0/);
  assert.match(output, /Agreement: 3\/6 \(differed 1, abstained 1, overreach 1\)/);
  assert.match(output, /Missing candidate: maintenance\.call-technician@1\/call-technician/);
  const cli = execFileSync(process.execPath, ['scripts/replay.mjs', dir, '--labels', join(dir, 'labels.json')], { encoding: 'utf8' });
  assert.match(cli, /Agreement: 3\/6; differed 1, abstained 1, overreach 1/); assert.match(cli, /Recall: 0\.80/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8')).length, 6);
});
