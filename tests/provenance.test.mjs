import test from 'node:test';
import assert from 'node:assert/strict';
import { HubError, MemoryDecisionStore, MemoryJournal, MemoryRunStore, timeline } from '../dist/index.js';
import { deferred, fixture, intent, tick } from './fixtures.mjs';
import { boot, createPlatform, spec } from './runtime-host.mjs';

// Every turn and every step says what it did and who decided, without the host diffing state or re-deriving causes.

test('every turn has a decision id that names its record; an overlapping turn has none', async () => {
  const decisions = new MemoryDecisionStore();
  const f = await fixture({ hub: { decisions } });
  const p = await f.hub.propose(intent());
  assert.equal(p.kind, 'proposal');
  const record = await decisions.get(p.decisionId);
  assert.equal(record.id, p.decisionId); assert.equal(record.phase, 'commit'); assert.equal(record.provider, 'fixture');
  assert.equal(await decisions.get('missing'), undefined);
  const unrecorded = await (await fixture()).hub.propose(intent());
  assert.match(unrecorded.decisionId, /^[0-9a-f-]{36}$/);
  const gate = deferred(), entered = deferred();
  const g = await fixture({ hub: { decision: { name: 'slow', async decide(r) { entered.resolve(); await gate.promise;
    return { kind: 'action', candidateId: r.candidates[0].id }; } } } });
  const first = g.hub.propose(intent()); await entered.promise;
  const overlapping = await g.hub.propose(intent());
  assert.equal(overlapping.kind, 'wait'); assert.equal('decisionId' in overlapping, false);
  gate.resolve(); assert.ok((await first).decisionId);
});

test('a provider stamped on the decision is recorded, the configured name otherwise, and an invalid one fails the turn', async () => {
  const decisions = new MemoryDecisionStore(); let provider = 'rules-v2';
  const f = await fixture({ hub: { decisions, decision: { name: 'router', async decide(r) {
    return { kind: 'action', candidateId: r.candidates[0].id, ...(provider === undefined ? {} : { provider }) }; } } } });
  const stamped = await f.hub.propose(intent());
  assert.equal((await decisions.get(stamped.decisionId)).provider, 'rules-v2');
  f.hub.discard(stamped.id); provider = undefined;
  const plain = await f.hub.propose(intent());
  assert.equal((await decisions.get(plain.decisionId)).provider, 'router');
  f.hub.discard(plain.id); provider = '';
  const invalid = await f.hub.propose(intent());
  assert.equal(invalid.kind, 'deliberation');
  assert.deepEqual([invalid.request.subject.cause, invalid.request.subject.code, invalid.request.subject.phase], ['failed', 'invalid-contract', 'decide']);
});

const causes = [
  ['no requested capability', { intent: { capabilities: [] } }, { cause: 'no-candidates', code: null, phase: 'policy', considered: 0, candidates: 0, excluded: 0 }],
  ['every candidate excluded by policy', { control: { allow: false } }, { cause: 'no-candidates', code: null, phase: 'policy', considered: 1, candidates: 0, excluded: 1 }],
  ['the decider asks', { hub: { decision: { name: 'asker', async decide() { return { kind: 'deliberate', reason: 'Need a plan' }; } } } },
    { cause: 'decider-asked', code: null, phase: 'decide', considered: 1, candidates: 1, excluded: 0 }],
  ['the decider fails', { hub: { decision: { name: 'down', async decide() { throw new HubError('jev-http-429', 'rate limited'); } } } },
    { cause: 'failed', code: 'jev-http-429', phase: 'decide', considered: 1, candidates: 1, excluded: 0 }],
  ['observation fails', { hub: { state: { async observe() { throw new Error('sensor offline'); } } } },
    { cause: 'failed', code: 'decision-unavailable', phase: 'observe', considered: 0, candidates: 0, excluded: 0 }],
  ['prepare fails', { capability: { async prepare() { throw new Error('adapter bug'); } } },
    { cause: 'failed', code: 'decision-unavailable', phase: 'prepare', considered: 0, candidates: 0, excluded: 0 }],
  ['policy fails', { hub: { policy: { async check() { throw new HubError('policy-down', 'authorization service unreachable'); } } } },
    { cause: 'failed', code: 'policy-down', phase: 'policy', considered: 1, candidates: 0, excluded: 0 }],
];
for (const [name, setup, expected] of causes) test(`a deliberation subject explains why: ${name}`, async () => {
  const decisions = new MemoryDecisionStore();
  const f = await fixture({ ...setup, hub: { decisions, ...setup.hub } });
  Object.assign(f.control, setup.control);
  const r = await f.hub.propose(intent(setup.intent));
  assert.equal(r.kind, 'deliberation');
  const { subject } = r.request;
  assert.equal(r.request.kind, 'decision');
  assert.deepEqual({ cause: subject.cause, code: subject.code, phase: subject.phase, considered: subject.considered,
    candidates: subject.candidates.length, excluded: subject.excluded.length }, expected);
  assert.equal(subject.decisionId, r.decisionId);
  const record = await decisions.get(r.decisionId);
  assert.equal(record.phase, expected.phase); assert.equal(record.code, expected.code);
  if (expected.excluded) assert.equal(subject.excluded[0].reason, 'host policy');
});

test('state that expires while deciding is a decide-phase failure', async () => {
  let f;
  f = await fixture({ hub: { decision: { name: 'slow', async decide(r) { f.control.now += 20000; return { kind: 'action', candidateId: r.candidates[0].id }; } } } });
  const r = await f.hub.propose(intent());
  assert.deepEqual([r.request.subject.cause, r.request.subject.code, r.request.subject.phase], ['failed', 'stale-state', 'decide']);
});

test('a deadline during a slow prepare reports the prepare phase, even after the late callback returns', async () => {
  const gate = deferred(), entered = deferred(), decisions = new MemoryDecisionStore();
  const f = await fixture({ hub: { decisions, decisionTimeoutMs: 20 }, capability: { async prepare() {
    entered.resolve(); await gate.promise;
    return [{ key: 'recover-r01', description: 'Request recovery of R01', input: { robotId: 'R01' }, resources: ['robot:R01'] }];
  } } });
  const pending = f.hub.propose(intent()); await entered.promise;
  const r = await pending;
  assert.deepEqual([r.request.subject.code, r.request.subject.phase], ['timeout', 'prepare']);
  gate.resolve(); await tick(); await tick();
  const record = await decisions.get(r.decisionId);
  assert.equal(record.phase, 'prepare'); assert.equal(record.request, null); assert.deepEqual(record.considered, []);
  await f.plugins.stop('robot');
});

test('DOMException failures get stable codes instead of numeric legacy ones', async () => {
  const timeout = await fixture({ hub: { decision: { name: 'dom', async decide() { throw new DOMException('late', 'TimeoutError'); } } } });
  assert.equal((await timeout.hub.propose(intent())).request.subject.code, 'timeout');
  const uncloneable = await fixture({ hub: { decision: { name: 'bad', async decide(r) { return { kind: 'action', candidateId: r.candidates[0].id, metadata: { f() {} } }; } } } });
  assert.equal((await uncloneable.hub.propose(intent())).request.subject.code, 'decision-unavailable');
});

test('a step reports its decision, the record it dispatched, and why it failed or was rejected', async () => {
  const decisions = new MemoryDecisionStore();
  const platform = createPlatform(); platform.info = 'given';
  const a = await boot(platform, { decisions });
  const run = await a.runtime.start(spec());
  const dispatched = await a.runtime.step(run.id);
  assert.equal(dispatched.outcome, 'waiting');
  assert.equal(dispatched.recordId, dispatched.run.operations[0]); assert.equal(dispatched.code, undefined);
  assert.equal((await decisions.get(dispatched.decisionId)).recordId, dispatched.recordId);

  const b = await boot(createPlatform(), { policy: { async check({ phase }) { return { allowed: phase === 'propose', version: 'p', reason: 'revoked at dispatch' }; } } });
  const run2 = await b.runtime.start(spec());
  const rejected = await b.runtime.step(run2.id);
  assert.equal(rejected.outcome, 'rejected'); assert.equal(rejected.code, 'policy-rejected');
  assert.ok(rejected.decisionId); assert.equal(rejected.recordId, undefined);

  const c = await boot(createPlatform(), { decision: { name: 'down', async decide() { throw new HubError('jev-http-529', 'overloaded'); } } });
  const run3 = await c.runtime.start(spec());
  const failed = await c.runtime.step(run3.id);
  assert.equal(failed.outcome, 'deliberating'); assert.equal(failed.code, 'jev-http-529');
  assert.equal(failed.run.request.subject.cause, 'failed'); assert.equal(c.inbox.pending().at(-1).subject.phase, 'decide');
});

test('a step whose recovery is blocked names the record and the code', async () => {
  const platform = createPlatform(); platform.info = 'given';
  const journal = new MemoryJournal(), runs = new MemoryRunStore();
  const a = await boot(platform, { journal, runs });
  const run = await a.runtime.start(spec());
  const first = await a.runtime.step(run.id);
  const b = await boot(platform, { journal: new MemoryJournal(journal.entries()), runs: new MemoryRunStore(runs.entries()), pluginVersion: '2.0.0', clock: a.clock });
  const blocked = await b.runtime.step(run.id);
  assert.equal(blocked.outcome, 'deliberating'); assert.equal(blocked.recordId, first.recordId); assert.equal(blocked.code, 'plugin-version-mismatch');
});

test('a request parked before v0.3 with a null subject can still be answered', async () => {
  const platform = createPlatform(); platform.stage = 2;           // no candidate until the fact arrives
  const { runtime } = await boot(platform, { runs: new MemoryRunStore() });
  const run = await runtime.start(spec());
  const asked = await runtime.step(run.id);
  assert.equal(asked.run.request.subject.cause, 'no-candidates');
  const legacy = { ...asked.run, revision: asked.run.revision + 1, request: { ...asked.run.request, subject: null } };
  await runtime.runs.replace(legacy, asked.run.revision);
  const answered = await runtime.respond(run.id, { kind: 'fact', requestId: asked.run.request.id, intentRevision: 1, note: null });
  assert.equal(answered.kind, 'applied'); assert.equal(answered.run.status, 'active');
});

test('the timeline shows where each turn ended and who decided', async () => {
  const decisions = new MemoryDecisionStore();
  const platform = createPlatform(); platform.info = 'given';
  const { runtime, host } = await boot(platform, { decisions,
    decision: { name: 'router', async decide(r) { return { kind: 'action', candidateId: r.candidates[0].id, provider: 'rules' }; } } });
  const run = await runtime.start(spec());
  await runtime.step(run.id); host.complete();
  const entries = await timeline({ decisions, journal: runtime.hub.journal, runs: runtime.runs }, { runId: run.id });
  const decision = entries.find(e => e.kind === 'decision');
  assert.equal(decision.detail.phase, 'commit'); assert.equal(decision.detail.provider, 'rules');
  assert.match(decision.summary, /by rules/);
});
