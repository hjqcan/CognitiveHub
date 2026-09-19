import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryJournal, MemoryRunStore } from '../dist/index.js';
import { boot, createPlatform, spec } from './runtime-host.mjs';

test('a run advances one action per step, asks for a missing fact, and completes on independent evidence', async () => {
  const platform = createPlatform();
  const { runtime, host, inbox, events } = await boot(platform);
  const run = await runtime.start(spec());
  assert.equal((await runtime.step(run.id)).outcome, 'waiting'); assert.equal(platform.submissions, 1);   // to-1 accepted
  assert.equal((await runtime.step(run.id)).outcome, 'waiting'); assert.equal(platform.submissions, 1);   // nothing changed: no decision
  host.complete();
  assert.equal((await runtime.step(run.id)).outcome, 'waiting'); assert.equal(platform.submissions, 2);   // to-1 verified, to-2 accepted
  host.complete();
  const asked = await runtime.step(run.id);                                                               // stage 2 needs a fact
  assert.equal(asked.outcome, 'deliberating'); assert.equal(asked.run.request.kind, 'decision');
  const [request] = inbox.pending();
  assert.equal(request.runId, run.id); assert.equal(request.kind, 'decision'); assert.equal(request.intent.id, 'workflow-1');
  assert.equal((await runtime.step(run.id)).outcome, 'deliberating');                                     // nothing happens until a response
  platform.info = 'route-B';
  const applied = await runtime.respond(run.id, { kind: 'fact', requestId: request.id, intentRevision: 1, note: { info: 'route-B' } });
  assert.equal(applied.kind, 'applied'); assert.equal(applied.run.status, 'active');
  assert.equal((await runtime.step(run.id)).outcome, 'waiting'); host.complete();                          // to-3
  const done = await runtime.step(run.id);
  assert.equal(done.outcome, 'completed'); assert.equal(done.run.status, 'completed'); assert.equal(done.run.lease, null);
  assert.deepEqual(done.run.outcome.evidence, { stage: 3 }); assert.deepEqual(done.run.progress, { stage: 3 });
  assert.equal(platform.submissions, 3); assert.equal(done.run.counters.actions, 3); assert.equal(done.run.counters.decisions, 4);
  assert.deepEqual(done.run.answers.map(a => a.kind), ['fact']);
  assert.equal((await runtime.step(run.id)).outcome, 'idle');
  assert.deepEqual(await runtime.deliver(run.id, { key: 'late', type: 'host', data: null }), { accepted: false, woke: false });
  assert.ok(events.entries().some(e => e.type === 'run.event.ignored'));
  await host.plugins.stop('sim');
});

test('a goal that already holds completes the run without any action', async () => {
  const platform = createPlatform(); platform.stage = 3;
  const { runtime, host } = await boot(platform);
  const run = await runtime.start(spec());
  const r = await runtime.step(run.id);
  assert.equal(r.outcome, 'completed'); assert.equal(platform.submissions, 0); assert.equal(r.run.counters.decisions, 0);
  await host.plugins.stop('sim');
});

test('model waits register state and time conditions; repeated no-progress wake-ups escalate', async () => {
  const platform = createPlatform(); let decisions = 0;
  const decision = { name: 'waiter', async decide() { decisions++; return { kind: 'wait', reason: 'Expecting the platform to move' }; } };
  const { runtime, clock, inbox } = await boot(platform, { decision });
  const run = await runtime.start(spec({ budget: { maxDecisions: 20, maxActions: 10, maxNoProgress: 2, deadlineAt: null } }));
  let r = await runtime.step(run.id);
  assert.equal(r.outcome, 'waiting'); assert.deepEqual(r.run.wait.map(c => c.kind), ['state', 'time']); assert.equal(decisions, 1);
  r = await runtime.step(run.id); assert.equal(r.outcome, 'waiting'); assert.equal(decisions, 1);
  clock.now = r.run.wait.find(c => c.kind === 'time').at;
  r = await runtime.step(run.id); assert.equal(r.outcome, 'waiting'); assert.equal(decisions, 2); assert.equal(r.run.counters.noProgress, 2);
  clock.now = r.run.wait.find(c => c.kind === 'time').at;
  r = await runtime.step(run.id);
  assert.equal(r.outcome, 'deliberating'); assert.equal(r.run.request.kind, 'no-progress'); assert.equal(decisions, 2);
  assert.equal(inbox.pending()[0].kind, 'no-progress');
});

test('events wake only matching wait conditions and are deduplicated by key', async () => {
  const platform = createPlatform(); platform.info = 'given';
  const { runtime } = await boot(platform);
  const run = await runtime.start(spec());
  const first = await runtime.step(run.id); const [recordId] = first.run.operations;
  assert.deepEqual(await runtime.deliver(run.id, { key: 'other', type: 'execution-updated', data: { recordId: 'someone-else' } }), { accepted: true, woke: false });
  assert.deepEqual(await runtime.deliver(run.id, { key: 'mine', type: 'execution-updated', data: { recordId } }), { accepted: true, woke: true });
  assert.equal((await runtime.get(run.id)).status, 'active');
  assert.deepEqual(await runtime.deliver(run.id, { key: 'mine', type: 'execution-updated', data: { recordId } }), { accepted: false, woke: false });
  // Woken, but the task is still running: the step reconciles, finds it open and waits again without deciding.
  const again = await runtime.step(run.id);
  assert.equal(again.outcome, 'waiting'); assert.equal(again.run.counters.decisions, 1); assert.equal(platform.submissions, 1);
  assert.deepEqual(await runtime.deliver(run.id, { key: 'nudge', type: 'host', data: null }), { accepted: true, woke: true });
});

test('an exhausted budget pauses into deliberation; revising the budget answers that request by itself', async () => {
  const platform = createPlatform(); platform.info = 'given';
  const { runtime, host, inbox } = await boot(platform);
  const run = await runtime.start(spec({ budget: { maxDecisions: 20, maxActions: 1, maxNoProgress: 3, deadlineAt: null } }));
  await runtime.step(run.id); host.complete();
  const r = await runtime.step(run.id);
  assert.equal(r.outcome, 'deliberating'); assert.equal(r.run.request.kind, 'budget'); assert.equal(inbox.pending().at(-1).kind, 'budget');
  await assert.rejects(runtime.revise(run.id, { budget: { maxActions: 0 } }), { code: 'invalid-budget' });
  const revised = await runtime.revise(run.id, { budget: { maxActions: 5 } });
  assert.equal(revised.kind, 'applied'); assert.equal(revised.run.budget.maxActions, 5); assert.equal(revised.run.status, 'active');
  assert.equal((await runtime.step(run.id)).outcome, 'waiting'); assert.equal(platform.submissions, 2);
});

test('stale or mismatched responses are rejected without changing the run', async () => {
  const platform = createPlatform();
  const { runtime, host, inbox } = await boot(platform);
  const run = await runtime.start(spec());
  await runtime.step(run.id); host.complete(); await runtime.step(run.id); host.complete();
  const asked = await runtime.step(run.id); assert.equal(asked.outcome, 'deliberating');
  const request = inbox.pending()[0];
  for (const [response, code] of [
    [{ kind: 'fact', requestId: 'other', intentRevision: 1, note: null }, 'stale-response'],
    [{ kind: 'fact', requestId: request.id, intentRevision: 2, note: null }, 'stale-response'],
    [{ kind: 'approve', requestId: request.id, intentRevision: 1, digest: 'x', stateVersion: 'y', expiresAt: 1 }, 'approval-mismatch'],
    [{ kind: 'guidance', requestId: request.id, intentRevision: 1, guidance: { version: 2, criteria: [], escalate: [], author: 'ops', createdAt: 1 } }, 'stale-guidance'],
  ]) { const r = await runtime.respond(run.id, response); assert.equal(r.kind, 'rejected'); assert.equal(r.code, code); }
  assert.equal((await runtime.get(run.id)).revision, asked.run.revision);
});

test('each-action approval binds one digest to one state version and is spent by use', async () => {
  const platform = createPlatform(); platform.info = 'given';
  const { runtime, inbox, clock } = await boot(platform);
  const run = await runtime.start(spec({ approval: 'each-action' }));
  const ask = await runtime.step(run.id);
  assert.equal(ask.outcome, 'deliberating'); assert.equal(ask.run.request.kind, 'approval'); assert.equal(platform.submissions, 0);
  const request = inbox.pending().at(-1); const { digest, stateVersion } = request.subject;
  assert.equal(request.subject.capability, 'sim.advance@1');
  const wrong = await runtime.respond(run.id, { kind: 'approve', requestId: request.id, intentRevision: 1, digest: 'other', stateVersion, expiresAt: clock.now + 1000 });
  assert.equal(wrong.code, 'approval-mismatch');
  const ok = await runtime.respond(run.id, { kind: 'approve', requestId: request.id, intentRevision: 1, digest, stateVersion, expiresAt: clock.now + 1000 });
  assert.equal(ok.kind, 'applied'); assert.equal(ok.run.approved.digest, digest);
  platform.info = 'changed'; // The state moved before dispatch: the approval no longer applies and is asked again.
  const stale = await runtime.step(run.id);
  assert.equal(stale.outcome, 'deliberating'); assert.equal(stale.run.approved, null); assert.equal(platform.submissions, 0);
  const again = inbox.pending().at(-1); assert.notEqual(again.id, request.id);
  await runtime.respond(run.id, { kind: 'approve', requestId: again.id, intentRevision: 1, digest: again.subject.digest, stateVersion: again.subject.stateVersion, expiresAt: clock.now + 1000 });
  const dispatched = await runtime.step(run.id);
  assert.equal(dispatched.outcome, 'waiting'); assert.equal(platform.submissions, 1); assert.equal(dispatched.run.approved, null);
});

test('guidance is versioned, reaches the decider as data, and is rejected when out of order', async () => {
  const platform = createPlatform(); platform.info = 'given'; const seen = [];
  const decision = { name: 'observer', async decide(request) { seen.push(request.guidance?.version ?? null); return { kind: 'deliberate', reason: 'Need criteria' }; } };
  const { runtime, inbox } = await boot(platform, { decision });
  const run = await runtime.start(spec());
  assert.equal((await runtime.step(run.id)).outcome, 'deliberating');
  const request = inbox.pending()[0];
  const guidance = { version: 1, criteria: ['Prefer the shortest route'], escalate: ['Any safety warning'], author: 'ops', createdAt: 1 };
  const applied = await runtime.respond(run.id, { kind: 'guidance', requestId: request.id, intentRevision: 1, guidance });
  assert.equal(applied.kind, 'applied'); assert.equal(applied.run.guidance.version, 1);
  await runtime.step(run.id);
  assert.deepEqual(seen, [null, 1]);
  assert.equal((await runtime.revise(run.id, { guidance: { ...guidance, version: 3 } })).code, 'stale-guidance');
  assert.equal((await runtime.revise(run.id, { guidance: { ...guidance, version: 2 } })).run.guidance.version, 2);
});

test('stop keeps reconciling open operations and never dispatches again', async () => {
  const platform = createPlatform(); platform.info = 'given';
  const { runtime, host } = await boot(platform);
  const run = await runtime.start(spec());
  await runtime.step(run.id);
  const stopping = await runtime.stop(run.id); assert.equal(stopping.run.status, 'stopping');
  assert.equal((await runtime.step(run.id)).outcome, 'waiting'); assert.equal((await runtime.get(run.id)).status, 'stopping');
  host.complete();
  const stopped = await runtime.step(run.id);
  assert.equal(stopped.outcome, 'stopped'); assert.equal(stopped.run.outcome.code, 'stopped');
  assert.equal(platform.submissions, 1); assert.equal(platform.stage, 1);
  assert.equal((await runtime.stop(run.id)).code, 'run-terminal');
  await host.plugins.stop('sim');
});

test('a terminate response ends the run after its open operation settles', async () => {
  const platform = createPlatform();
  const { runtime, host, inbox } = await boot(platform);
  const run = await runtime.start(spec());
  await runtime.step(run.id); host.complete(); await runtime.step(run.id); host.complete();
  assert.equal((await runtime.step(run.id)).outcome, 'deliberating');
  const request = inbox.pending()[0];
  const ended = await runtime.respond(run.id, { kind: 'terminate', requestId: request.id, intentRevision: 1, reason: 'Operator cancelled the job' });
  assert.equal(ended.run.status, 'stopped'); assert.equal(ended.run.outcome.code, 'terminated');
  assert.equal(platform.submissions, 2);
});

test('pause blocks stepping and resume re-observes or returns to the open request', async () => {
  const platform = createPlatform(); platform.info = 'given';
  const { runtime } = await boot(platform);
  const run = await runtime.start(spec());
  assert.equal((await runtime.pause(run.id)).run.status, 'paused');
  assert.equal((await runtime.step(run.id)).outcome, 'idle'); assert.equal(platform.submissions, 0);
  assert.equal((await runtime.resume(run.id)).run.status, 'active');
  assert.equal((await runtime.step(run.id)).outcome, 'waiting'); assert.equal(platform.submissions, 1);
  assert.equal((await runtime.resume(run.id)).code, 'run-state');
});

test('a live lease held by another worker skips the step; an expired one is taken over', async () => {
  const platform = createPlatform(); platform.info = 'given';
  const { runtime, clock } = await boot(platform, { owner: 'worker-a', leaseMs: 1000 });
  const run = await runtime.start(spec());
  await runtime.runs.replace({ ...run, revision: 1, lease: { owner: 'worker-b', expiresAt: clock.now + 500 } }, 0);
  assert.equal((await runtime.step(run.id)).outcome, 'lease-held'); assert.equal(platform.submissions, 0);
  clock.now += 501;
  const r = await runtime.step(run.id); assert.equal(r.outcome, 'waiting'); assert.equal(r.run.lease, null);
});

test('authorization revoked between decision and dispatch rejects the action and counts as no progress', async () => {
  const platform = createPlatform(); platform.info = 'given'; let revoked = false;
  const policy = { async check({ phase, action }) {
    return { allowed: action.capability === 'sim.advance@1' && !(revoked && phase === 'execute'), version: 'p1', reason: 'test' }; } };
  const { runtime, events } = await boot(platform, { policy });
  const run = await runtime.start(spec({ budget: { maxDecisions: 20, maxActions: 10, maxNoProgress: 2, deadlineAt: null } }));
  revoked = true;
  const r = await runtime.step(run.id);
  assert.equal(r.outcome, 'rejected'); assert.deepEqual(r.run.operations, []); assert.equal(r.run.counters.noProgress, 1); assert.equal(platform.submissions, 0);
  assert.ok(events.entries().some(e => e.type === 'run.dispatch.rejected' && e.data.code === 'policy-rejected'));
  assert.equal((await runtime.step(run.id)).outcome, 'rejected');
  const escalated = await runtime.step(run.id);
  assert.equal(escalated.outcome, 'deliberating'); assert.equal(escalated.run.request.kind, 'no-progress'); assert.equal(platform.submissions, 0);
});

test('a plugin version change after a restart blocks recovery into deliberation instead of re-dispatching', async () => {
  const platform = createPlatform(); platform.info = 'given';
  const a = await boot(platform);
  const run = await a.runtime.start(spec());
  await a.runtime.step(run.id);
  const journal = new MemoryJournal(JSON.parse(JSON.stringify(a.runtime.hub.journal.entries())));
  const runs = new MemoryRunStore(JSON.parse(JSON.stringify(a.runtime.runs.entries())));
  const b = await boot(platform, { journal, runs, pluginVersion: '2.0.0', clock: a.clock });
  const r = await b.runtime.step(run.id);
  assert.equal(r.outcome, 'deliberating'); assert.equal(r.run.request.kind, 'recovery');
  assert.equal(r.run.request.subject.code, 'plugin-version-mismatch'); assert.equal(platform.submissions, 1);
  assert.equal(b.inbox.pending()[0].runId, run.id);
});

test('an operation written before a crash but never claimed is dropped, not re-dispatched', async () => {
  const platform = createPlatform(); platform.info = 'given';
  const { runtime } = await boot(platform);
  const run = await runtime.start(spec());
  await runtime.runs.replace({ ...run, revision: 1, operations: ['phantom'], counters: { ...run.counters, actions: 1 } }, 0);
  const r = await runtime.step(run.id);
  assert.equal(r.outcome, 'waiting'); assert.equal(r.run.operations.length, 1); assert.notEqual(r.run.operations[0], 'phantom');
  assert.equal(platform.submissions, 1); assert.equal(r.run.counters.actions, 2);
});

test('one intent has at most one unsettled run, and specs are validated', async () => {
  const { runtime } = await boot(createPlatform());
  await runtime.start(spec());
  await assert.rejects(runtime.start(spec()), { code: 'run-exists' });
  await assert.rejects(runtime.start(spec({ approval: 'maybe' })), { code: 'invalid-run' });
  await assert.rejects(runtime.start(spec({ budget: { maxDecisions: 0, maxActions: 1, maxNoProgress: 1, deadlineAt: null } })), { code: 'invalid-budget' });
  await assert.rejects(runtime.step('missing'), { code: 'unknown-run' });
});

test('due lists active and stopping runs plus waiting runs whose time bound has passed', async () => {
  const platform = createPlatform(); platform.info = 'given';
  const { runtime, clock } = await boot(platform);
  const run = await runtime.start(spec());
  assert.deepEqual(await runtime.due(), [run.id]);
  const r = await runtime.step(run.id);
  assert.deepEqual(await runtime.due(), []);
  clock.now = r.run.wait.find(c => c.kind === 'time').at;
  assert.deepEqual(await runtime.due(), [run.id]);
});

test('a satisfied goal waits for open operations, and an unreachable goal fails the run', async () => {
  const platform = createPlatform(); platform.info = 'given'; let verdict = 'unsatisfied';
  const goal = { async evaluate({ observation }) { return { status: verdict, evidence: { stage: observation.facts.stage } }; } };
  const { runtime, host } = await boot(platform, { goal });
  const run = await runtime.start(spec());
  await runtime.step(run.id);
  verdict = 'satisfied';
  await runtime.deliver(run.id, { key: 'nudge', type: 'host', data: null });
  const waiting = await runtime.step(run.id); assert.equal(waiting.outcome, 'waiting'); assert.equal(waiting.run.status, 'waiting');
  host.complete();
  const done = await runtime.step(run.id); assert.equal(done.outcome, 'completed'); assert.equal(platform.submissions, 1);
  const other = await boot(createPlatform(), { goal: { async evaluate() { return { status: 'unreachable', evidence: { why: 'blocked' } }; } } });
  const run2 = await other.runtime.start(spec());
  const failed = await other.runtime.step(run2.id);
  assert.equal(failed.outcome, 'failed'); assert.deepEqual(failed.run.outcome.evidence, { why: 'blocked' }); assert.equal(failed.run.lease, null);
});

test('a revised intent invalidates the open request and approvals and restarts observation', async () => {
  const platform = createPlatform();
  const { runtime, host, inbox } = await boot(platform);
  const run = await runtime.start(spec());
  await runtime.step(run.id); host.complete(); await runtime.step(run.id); host.complete();
  assert.equal((await runtime.step(run.id)).outcome, 'deliberating');
  const request = inbox.pending()[0];
  assert.equal((await runtime.revise(run.id, { intent: { ...spec().intent, revision: 1 } })).code, 'stale-intent');
  assert.equal((await runtime.revise(run.id, { intent: { ...spec().intent, id: 'other', revision: 2 } })).code, 'intent-mismatch');
  const revised = await runtime.revise(run.id, { intent: { ...spec().intent, revision: 2, objective: 'Reach stage 3 via route B' } });
  assert.equal(revised.run.status, 'active'); assert.equal(revised.run.request, null);
  assert.equal((await runtime.respond(run.id, { kind: 'fact', requestId: request.id, intentRevision: 1, note: null })).code, 'stale-response');
  platform.info = 'given';
  assert.equal((await runtime.step(run.id)).outcome, 'waiting'); assert.equal(platform.submissions, 3);
});
