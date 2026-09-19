import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryJournal } from '../dist/index.js';
import { fixture, intent, deferred, tick } from './fixtures.mjs';

const accepted = { status: 'accepted', handle: 'H1', evidence: null };
const exported = journal => JSON.parse(JSON.stringify(journal.entries()));
// A later process: new plugin host, new hub, journal rebuilt from exported JSON. The crashed one is simply abandoned.
const restart = (f, options = {}) => fixture({ journal: new MemoryJournal(exported(f.journal)), ...options });

test('a restarted hub reconciles an accepted operation through a re-bound capability without re-executing', async () => {
  let calls = 0, done = false;
  const capability = {
    execute: async () => { calls++; return accepted; },
    reconcile: async () => done ? { status: 'completed', evidence: { found: true } } : accepted,
    verify: async () => ({ status: done ? 'verified' : 'pending', evidence: { done } }),
  };
  const f = await fixture({ capability }), p = await f.hub.propose(intent());
  const first = await f.hub.execute(p.id, 'op', { live: true });
  assert.equal(first.record.status, 'pending');
  const g = await restart(f, { capability });
  done = true;
  const r = await g.hub.reconcile(first.record.id);
  assert.equal(r.kind, 'record'); assert.equal(r.record.status, 'verified'); assert.equal(r.unchanged, false);
  assert.deepEqual(r.record.evidence, { done: true }); assert.equal(calls, 1);
  assert.ok(g.events.entries().some(e => e.type === 'execution.recovered' && e.data.id === first.record.id));
  await g.plugins.stop('robot'); assert.equal(g.control.disposed, true);
});

test('a crash between claim and receipt is queried with a null receipt', async () => {
  let calls = 0, receiptSeen = 'unset';
  const capability = {
    execute: async () => { calls++; return { status: 'completed', evidence: null }; },
    reconcile: async (_context, receipt) => { receiptSeen = receipt; return { status: 'completed', evidence: { byKey: true } }; },
    verify: async () => ({ status: 'verified', evidence: { taskState: 'done' } }),
  };
  const f = await fixture({ capability });
  f.journal.replace = async () => { throw new Error('storage down'); };
  const p = await f.hub.propose(intent());
  await assert.rejects(f.hub.execute(p.id, 'op', { live: true }), /storage down/);
  const [open] = f.journal.entries(); assert.equal(open.status, 'submitted');
  const g = await restart(f, { capability });
  const r = await g.hub.reconcile(open.id);
  assert.equal(receiptSeen, null); assert.equal(r.record.status, 'verified'); assert.equal(calls, 1);
  await g.plugins.stop('robot');
});

test('a crash between claim and receipt without a query hook is verified from an unknown receipt', async () => {
  const receipts = [];
  const capability = { verify: async (_context, receipt) => { receipts.push(receipt.status); return { status: 'verified', evidence: { seen: true } }; } };
  const f = await fixture({ capability });
  f.journal.replace = async () => { throw new Error('storage down'); };
  const p = await f.hub.propose(intent());
  await assert.rejects(f.hub.execute(p.id, 'op', { live: true }), /storage down/);
  const g = await restart(f, { capability });
  assert.equal((await g.hub.reconcile(f.journal.entries()[0].id)).record.status, 'verified');
  assert.deepEqual(receipts, ['unknown']); assert.equal(g.control.calls, 0); assert.equal(f.control.calls, 1);
  await g.plugins.stop('robot');
});

test('recovery is blocked when the plugin version differs', async () => {
  const capability = { execute: async () => accepted };
  const f = await fixture({ capability }), p = await f.hub.propose(intent());
  const first = await f.hub.execute(p.id, 'op', { live: true });
  const g = await restart(f, { capability, pluginVersion: '2.0.0' });
  const r = await g.hub.reconcile(first.record.id);
  assert.equal(r.kind, 'rejected'); assert.equal(r.code, 'plugin-version-mismatch');
  assert.deepEqual(await g.journal.get(first.record.id), first.record);
  assert.ok(g.events.entries().some(e => e.type === 'execution.recovery.blocked' && e.data.code === 'plugin-version-mismatch'));
  const other = await g.hub.propose(intent({ id: 'other-task' }));
  const blocked = await g.hub.execute(other.id, 'other-op', { live: true });
  assert.equal(blocked.kind, 'rejected'); assert.equal(blocked.code, 'claim-conflict');
  await g.plugins.stop('robot'); // No lease was taken, so nothing drains.
});

test('recovery is blocked when the capability is missing or outside scope', async () => {
  const capability = { execute: async () => accepted };
  const f = await fixture({ capability }), p = await f.hub.propose(intent());
  const first = await f.hub.execute(p.id, 'op', { live: true });
  const g = await restart(f, { capability, scope: ['tenant-b'] });
  const r = await g.hub.reconcile(first.record.id);
  assert.equal(r.kind, 'rejected'); assert.equal(r.code, 'unavailable-capability');
  await g.plugins.stop('robot');
  const h = await restart(f, { capability });
  await h.plugins.stop('robot'); h.plugins.uninstall('robot');
  assert.equal((await h.hub.reconcile(first.record.id)).code, 'unavailable-capability');
});

test('operation retries after restart return the existing record', async () => {
  let calls = 0;
  const capability = { execute: async () => { calls++; return accepted; } };
  const f = await fixture({ capability }), p = await f.hub.propose(intent());
  const first = await f.hub.execute(p.id, 'op', { live: true });
  const g = await restart(f, { capability });
  await g.plugins.stop('robot'); await g.plugins.start(); // A different activation than the record was bound to.
  const again = await g.hub.propose(intent());
  const retry = await g.hub.execute(again.id, 'op', { live: true });
  assert.equal(retry.kind, 'record'); assert.equal(retry.unchanged, true); assert.equal(retry.record.id, first.record.id);
  assert.equal(calls, 1);
  await g.plugins.stop('robot');
});

test('journal entries round-trip through JSON and rebuild reservations', async () => {
  const f = await fixture({ capability: { execute: async () => accepted } });
  const p = await f.hub.propose(intent()); const open = (await f.hub.execute(p.id, 'open', { live: true })).record;
  const journal = new MemoryJournal(exported(f.journal));
  assert.deepEqual(await journal.unsettled(), [open]);
  const rival = { ...open, id: 'rival', operationId: 'rival', revision: 0, status: 'submitted', receipt: null };
  assert.equal((await journal.claim(rival)).kind, 'conflict');
  const settled = { ...open, revision: open.revision + 1, status: 'verified', evidence: { done: true } };
  assert.equal((await new MemoryJournal([settled]).claim(rival)).kind, 'claimed');
  assert.throws(() => new MemoryJournal([open, open]), { code: 'invalid-record' });
  assert.throws(() => new MemoryJournal([open, rival]), { code: 'journal-conflict' });
  assert.throws(() => new MemoryJournal([{ ...open, status: 'made-up' }]), { code: 'invalid-record' });
  assert.throws(() => new MemoryJournal([{ ...open, receipt: { status: 'made-up', evidence: null } }]), { code: 'invalid-receipt' });
});

test('a recovered record keeps the plugin leased until it settles', async () => {
  let done = false;
  const capability = { execute: async () => accepted, verify: async () => ({ status: done ? 'verified' : 'pending', evidence: { done } }) };
  const f = await fixture({ capability }), p = await f.hub.propose(intent());
  const first = await f.hub.execute(p.id, 'op', { live: true });
  const g = await restart(f, { capability });
  assert.equal((await g.hub.reconcile(first.record.id)).record.status, 'pending');
  let stopped = false; const stop = g.plugins.stop('robot').then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false); assert.equal(g.plugins.status('robot'), 'draining');
  done = true;
  assert.equal((await g.hub.reconcile(first.record.id)).record.status, 'verified');
  await stop; assert.equal(g.control.disposed, true);
});

test('an externally settled record releases the local lease', async () => {
  let done = false;
  const capability = { execute: async () => accepted, verify: async () => ({ status: done ? 'verified' : 'pending', evidence: { done } }) };
  const f = await fixture({ capability }), p = await f.hub.propose(intent());
  const first = await f.hub.execute(p.id, 'op', { live: true });
  const g = await fixture({ journal: f.journal, capability }); // Two hubs over one store.
  done = true;
  assert.equal((await g.hub.reconcile(first.record.id)).record.status, 'verified');
  const seen = await f.hub.reconcile(first.record.id);
  assert.equal(seen.record.status, 'verified'); assert.equal(seen.unchanged, true);
  await f.plugins.stop('robot'); await g.plugins.stop('robot');
  assert.equal(f.control.disposed, true); assert.equal(g.control.disposed, true);
});

test('a lost reconcile race is reported as a conflict and then converges on the winner', async () => {
  const gate = deferred(); let queries = 0;
  const capability = {
    execute: async () => accepted,
    reconcile: async () => { queries++; await gate.promise; return { status: 'completed', evidence: null }; },
    verify: async () => ({ status: 'verified', evidence: { done: true } }),
  };
  const f = await fixture({ capability }), p = await f.hub.propose(intent());
  const first = await f.hub.execute(p.id, 'op', { live: true });
  const g = await fixture({ journal: f.journal, capability });
  const race = [f.hub.reconcile(first.record.id), g.hub.reconcile(first.record.id)];
  await tick(); assert.equal(queries, 2); gate.resolve();
  const results = await Promise.all(race);
  const winner = results.find(r => r.kind === 'record'), loser = results.find(r => r.kind === 'rejected');
  assert.equal(winner.record.status, 'verified'); assert.equal(loser.code, 'journal-conflict');
  assert.equal((await f.journal.get(first.record.id)).status, 'verified');
  for (const h of [f, g]) assert.equal((await h.hub.reconcile(first.record.id)).unchanged, true);
  await f.plugins.stop('robot'); await g.plugins.stop('robot');
});

test('a failed outcome query is reported as rejected with the record unchanged', async () => {
  let fail = true;
  const capability = {
    execute: async () => accepted,
    reconcile: async () => { if (fail) throw new Error('query unavailable'); return { status: 'completed', evidence: null }; },
    verify: async () => ({ status: 'verified', evidence: null }),
  };
  const f = await fixture({ capability }), p = await f.hub.propose(intent());
  const first = await f.hub.execute(p.id, 'op', { live: true });
  const g = await restart(f, { capability });
  const r = await g.hub.reconcile(first.record.id);
  assert.equal(r.kind, 'rejected'); assert.equal(r.code, 'reconcile-failed');
  assert.deepEqual(await g.journal.get(first.record.id), first.record);
  let stopped = false; const stop = g.plugins.stop('robot').then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false); // The adopted record still holds its lease.
  fail = false;
  assert.equal((await g.hub.reconcile(first.record.id)).record.status, 'verified');
  await stop;
});

test('expired observations do not block recovery queries', async () => {
  const capability = { execute: async () => accepted, verify: async () => ({ status: 'verified', evidence: null }) };
  const f = await fixture({ capability }), p = await f.hub.propose(intent());
  const first = await f.hub.execute(p.id, 'op', { live: true });
  const g = await restart(f, { capability });
  g.control.now = first.record.observation.validUntil + 1;
  assert.equal((await g.hub.reconcile(first.record.id)).record.status, 'verified');
  await g.plugins.stop('robot');
});

test('unsettled lists only non-terminal records', async () => {
  let done = false;
  const capability = { execute: async () => accepted, verify: async () => ({ status: done ? 'verified' : 'pending', evidence: null }) };
  const f = await fixture({ capability });
  const a = await f.hub.propose(intent()), ra = await f.hub.execute(a.id, 'first', { live: true });
  done = true; assert.equal((await f.hub.reconcile(ra.record.id)).record.status, 'verified'); done = false;
  const b = await f.hub.propose(intent({ id: 'task-2' })), rb = await f.hub.execute(b.id, 'second', { live: true });
  assert.equal(rb.record.status, 'pending');
  assert.deepEqual((await f.journal.unsettled()).map(r => r.id), [rb.record.id]);
  assert.equal(f.journal.entries().length, 2);
});
