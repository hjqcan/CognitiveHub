import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginHost } from '../dist/plugins.js';
import { MemoryJournal, MemoryRunStore } from '../dist/memory.js';
import { capabilityPlugin, fixture, spec } from './v021-fixtures.mjs';
const copy = value => JSON.parse(JSON.stringify(value));

for (const kind of ['fact', 'guidance']) test(`stop remains sticky across missing-plugin recovery, restart and ${kind} response`, async () => {
  const f = await fixture(); f.control.accepted = true;
  const run = await f.runtime.start(spec()); await f.runtime.step(run.id); await f.runtime.stop(run.id);
  const runs = new MemoryRunStore(copy(f.runs.entries()));
  const journal = new MemoryJournal(copy(f.journal.entries()));
  const g = await fixture({ control: f.control, runs, journal, empty: true });
  const blocked = await g.runtime.step(run.id);
  assert.equal(blocked.run.status, 'deliberating'); assert.equal(blocked.run.stopRequested, true);
  g.plugins.install(capabilityPlugin(f.control)); await g.plugins.start();
  const answer = { requestId: blocked.run.request.id, intentRevision: 1,
    ...(kind === 'fact' ? { kind, note: 'Plugin restored' } : { kind, guidance: {
      version: 1, criteria: [], escalate: [], author: 'operator', createdAt: f.control.now } }) };
  assert.equal((await g.runtime.respond(run.id, answer)).run.status, 'stopping');
  f.control.done = true;
  const settled = await g.runtime.step(run.id);
  assert.equal(settled.run.status, 'stopped'); assert.equal(f.control.calls, 1);
});

test('revising a budget or intent during stop recovery cannot reactivate dispatch', async () => {
  const f = await fixture(); f.control.accepted = true;
  const run = await f.runtime.start(spec()); await f.runtime.step(run.id); await f.runtime.stop(run.id);
  const g = await fixture({ control: f.control, empty: true, runs: new MemoryRunStore(copy(f.runs.entries())),
    journal: new MemoryJournal(copy(f.journal.entries())) });
  await g.runtime.step(run.id);
  const changed = await g.runtime.revise(run.id, { intent: { ...run.intent, revision: 2 } });
  assert.equal(changed.run.status, 'stopping'); assert.equal(changed.run.stopRequested, true);
  g.plugins.install(capabilityPlugin(f.control)); await g.plugins.start(); f.control.done = true;
  assert.equal((await g.runtime.step(run.id)).run.status, 'stopped'); assert.equal(f.control.calls, 1);
});

for (const version of ['1.0.0', '2.0.0']) test(`uninstall/reinstall ${version} never revives an old proposal`, async () => {
  const f = await fixture();
  const proposal = await f.runtime.hub.propose(spec().intent);
  assert.equal(proposal.kind, 'proposal');
  await f.plugins.stop('test.plugin'); f.plugins.uninstall('test.plugin');
  f.plugins.install(capabilityPlugin(f.control, version)); await f.plugins.start();
  assert.notEqual(f.plugins.list(spec().intent.scope)[0].activation, proposal.action.activation);
  const result = await f.runtime.hub.execute(proposal.id, 'op', { live: true });
  assert.equal(result.kind, 'rejected'); assert.equal(f.control.calls, 0);
});

test('acquire also checks an explicitly supplied plugin version', async () => {
  const f = await fixture(); const r = f.plugins.list(spec().intent.scope)[0];
  assert.throws(() => f.plugins.acquire(r.pluginId, r.capability.id, r.activation, spec().intent.scope, 'wrong'),
    { code: 'unavailable-capability' });
});

test('an approval expiring during inference does not authorize execution', async () => {
  const f = await fixture(); const run = await f.runtime.start(spec({ approval: 'each-action' }));
  const question = (await f.runtime.step(run.id)).run.request;
  await f.runtime.respond(run.id, { kind: 'approve', requestId: question.id, intentRevision: 1,
    digest: question.subject.digest, stateVersion: question.subject.stateVersion, expiresAt: 1010 });
  f.control.deciding = () => { f.control.now = 1020; };
  const result = await f.runtime.step(run.id);
  assert.equal(result.run.status, 'deliberating'); assert.equal(result.run.request.kind, 'approval');
  assert.equal(f.control.calls, 0);
});

test('a Run deadline expiring during inference does not dispatch', async () => {
  const f = await fixture(); const settings = spec();
  const run = await f.runtime.start({ ...settings, budget: { ...settings.budget, deadlineAt: 1010 } });
  f.control.deciding = () => { f.control.now = 1020; };
  const result = await f.runtime.step(run.id);
  assert.equal(result.run.request.kind, 'budget'); assert.equal(f.control.calls, 0);
});

for (const phase of ['preflight', 'claim']) test(`approval is rechecked after ${phase}, not only after inference`, async () => {
  const f = await fixture(); const run = await f.runtime.start(spec({ approval: 'each-action' }));
  const question = (await f.runtime.step(run.id)).run.request;
  await f.runtime.respond(run.id, { kind: 'approve', requestId: question.id, intentRevision: 1,
    digest: question.subject.digest, stateVersion: question.subject.stateVersion, expiresAt: 1010 });
  if (phase === 'preflight') f.control.preflight = () => { f.control.now = 1020; };
  else {
    const claim = f.journal.claim.bind(f.journal);
    f.journal.claim = async record => { const result = await claim(record); f.control.now = 1020; return result; };
  }
  await f.runtime.step(run.id);
  assert.equal(f.control.calls, 0);
  assert.equal((await f.journal.unsettled()).length, 0);
});

test('deadline reaches the executor gateway; a later retry only reads the existing result', async () => {
  const f = await fixture(); const p = await f.runtime.hub.propose(spec().intent);
  const first = await f.runtime.hub.execute(p.id, 'op', { live: true, deadlineAt: 1010 });
  assert.equal(first.record.status, 'verified'); assert.equal(f.control.contexts[0].dispatchDeadlineAt, 1010);
  f.control.now = 1020;
  assert.equal((await f.runtime.hub.execute(p.id, 'op', { live: true, deadlineAt: 1010 })).unchanged, true);
  assert.equal(f.control.calls, 1);
});

test('failed event wake-up CAS consumes nothing, including across restart', async () => {
  const f = await fixture(); f.control.mode = 'wait'; const run = await f.runtime.start(spec());
  await f.runtime.step(run.id);
  const replace = f.runs.replace.bind(f.runs); let fail = true;
  f.runs.replace = async (next, revision) => {
    if (fail && next.processedEvents?.includes('event-1')) { fail = false; throw new Error('storage failure'); }
    return replace(next, revision);
  };
  const event = { key: 'event-1', type: 'host', data: null };
  await assert.rejects(f.runtime.deliver(run.id, event), /storage failure/);
  assert.equal((await f.runs.get(run.id)).processedEvents.includes('event-1'), false);
  const g = await fixture({ runs: new MemoryRunStore(copy(f.runs.entries())), control: f.control });
  assert.deepEqual(await g.runtime.deliver(run.id, event), { accepted: true, woke: true });
  assert.deepEqual(await g.runtime.deliver(run.id, event), { accepted: false, woke: false });
});

test('a lost event commit acknowledgment leaves the wake-up and dedup key together', async () => {
  const f = await fixture(); f.control.mode = 'wait'; const run = await f.runtime.start(spec());
  await f.runtime.step(run.id);
  const replace = f.runs.replace.bind(f.runs); let fail = true;
  f.runs.replace = async (next, revision) => {
    await replace(next, revision);
    if (fail && next.processedEvents?.includes('event-2')) { fail = false; throw new Error('ack lost'); }
  };
  const event = { key: 'event-2', type: 'host', data: null };
  await assert.rejects(f.runtime.deliver(run.id, event), /ack lost/);
  assert.equal((await f.runs.get(run.id)).status, 'active');
  assert.deepEqual(await f.runtime.deliver(run.id, event), { accepted: false, woke: false });
});

test('no notification escapes before the Run/request/outbox commit', async () => {
  let delivered = 0;
  const f = await fixture({ inbox: { async request() { delivered++; } } }); f.control.mode = 'ask';
  const run = await f.runtime.start(spec());
  const replace = f.runs.replace.bind(f.runs); let fail = true;
  f.runs.replace = async (next, revision) => {
    if (fail && next.outbox) { fail = false; throw new Error('park failed'); }
    return replace(next, revision);
  };
  await assert.rejects(f.runtime.step(run.id), /park failed/); assert.equal(delivered, 0);
  await f.runtime.step(run.id); assert.equal(delivered, 1);
});

for (const mode of ['ask', 'approval']) test(`${mode} requests are committed before sending and recover after a delivery failure`, async () => {
  const deliveries = []; let fail = true, f;
  const inbox = { async request(message) {
    deliveries.push(message.id);
    const persisted = await f.runs.get(message.runId);
    assert.equal(persisted.request.id, message.id); assert.equal(persisted.outbox.message.id, message.id);
    if (fail) { fail = false; throw new Error('network failed'); }
  } };
  f = await fixture({ inbox }); f.control.mode = mode === 'ask' ? 'ask' : 'action';
  const run = await f.runtime.start(spec({ approval: mode === 'approval' ? 'each-action' : 'automatic' }));
  await assert.rejects(f.runtime.step(run.id), /network failed/);
  const requestId = (await f.runs.get(run.id)).request.id;
  assert.equal((await f.runtime.due()).includes(run.id), false);
  const runs = new MemoryRunStore(copy(f.runs.entries())); f.control.now += 30;
  f = await fixture({ runs, inbox, control: f.control });
  assert.ok((await f.runtime.due()).includes(run.id));
  await f.runtime.step(run.id);
  assert.deepEqual(deliveries, [requestId, requestId]);
  assert.equal((await f.runs.get(run.id)).outbox.delivered, true);
  assert.equal((await f.runtime.respond(run.id, { kind: 'fact', requestId, intentRevision: 1, note: null })).kind, 'applied');
});

test('notification acknowledgment failure retries the same ID, never a new question', async () => {
  const messages = new Map(); let calls = 0;
  const f = await fixture({ inbox: { async request(message) { calls++; messages.set(message.id, message); } } });
  f.control.mode = 'ask'; const run = await f.runtime.start(spec());
  const replace = f.runs.replace.bind(f.runs); let fail = true;
  f.runs.replace = async (next, revision) => {
    if (fail && next.outbox?.delivered) { fail = false; throw new Error('ack storage failed'); }
    return replace(next, revision);
  };
  await assert.rejects(f.runtime.step(run.id), /ack storage failed/);
  const requestId = (await f.runs.get(run.id)).request.id;
  await f.runtime.step(run.id);
  assert.equal(messages.size, 1); assert.equal(calls, 2); assert.ok(messages.has(requestId));
});

test('a response arriving after delivery failure cancels the pending notification', async () => {
  let calls = 0;
  const f = await fixture({ inbox: { async request() { calls++; throw new Error('ack lost'); } } });
  f.control.mode = 'ask'; const run = await f.runtime.start(spec());
  await assert.rejects(f.runtime.step(run.id), /ack lost/);
  const requestId = (await f.runs.get(run.id)).request.id;
  await f.runtime.respond(run.id, { kind: 'fact', requestId, intentRevision: 1, note: null });
  f.control.mode = 'wait'; await f.runtime.step(run.id);
  assert.equal(calls, 1); assert.equal((await f.runs.get(run.id)).outbox, null);
});

test('same tenant and intent ID may run in separate complete scopes', async () => {
  const f = await fixture(); const settings = spec(); await f.runtime.start(settings);
  await f.runtime.start({ ...settings, intent: { ...settings.intent, scope: ['tenant', 'other-device'] } });
  await assert.rejects(f.runtime.start(settings), { code: 'run-exists' });
});

test('legacy exported event receipts migrate into the atomic Run inbox', async () => {
  const f = await fixture(); const run = await f.runtime.start(spec());
  const old = copy(run); delete old.processedEvents;
  const runs = new MemoryRunStore([old], [JSON.stringify([run.id, 'legacy-event'])]);
  const g = await fixture({ runs });
  assert.deepEqual(await g.runtime.deliver(run.id, { key: 'legacy-event', type: 'host', data: null }),
    { accepted: false, woke: false });
});
