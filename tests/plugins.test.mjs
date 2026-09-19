import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginHost } from '../dist/index.js';
import { fixture, intent, tick } from './fixtures.mjs';
const plugin = (id, setup, extra = {}) => ({ manifest: { apiVersion: 1, id, version: '1.0.0', ...extra }, setup });

test('activation resolves declared services independent of installation order', async () => {
  const host = new PluginHost(), order = [];
  host.install(plugin('consumer', ctx => { assert.equal(ctx.service('clock'), 42); order.push('consumer'); }, { requires: ['clock'] }));
  host.install(plugin('provider', ctx => { ctx.provide('clock', 42); order.push('provider'); }, { provides: ['clock'] }));
  await host.start(); assert.deepEqual(order, ['provider', 'consumer']);
  await assert.rejects(host.stop('provider'), { code: 'active-dependent' });
  await host.stop('consumer'); await host.stop('provider');
});
test('duplicate plugins and unsupported plugin ABI are rejected', () => {
  const host = new PluginHost(); host.install(plugin('p', () => {}));
  assert.throws(() => host.install(plugin('p', () => {})), { code: 'duplicate-plugin' });
  assert.throws(() => host.install({ manifest: { apiVersion: 2, id: 'q', version: '1' }, setup() {} }), { code: 'plugin-api' });
});
test('missing and cyclic dependencies fail without partial activation', async () => {
  const host = new PluginHost(); let disposed = false;
  host.install(plugin('ready', ctx => { ctx.onDispose(() => { disposed = true; }); }));
  host.install(plugin('a', () => {}, { requires: ['b'], provides: ['a'] }));
  host.install(plugin('b', () => {}, { requires: ['a'], provides: ['b'] }));
  await assert.rejects(host.start(), { code: 'missing-dependency' });
  assert.equal(disposed, true); assert.equal(host.status('ready'), 'stopped');
});
test('activation failure removes contributed services and unwinds resources in LIFO order', async () => {
  const host = new PluginHost(), cleanup = [];
  host.install(plugin('bad', ctx => { ctx.provide('x', 1); ctx.onDispose(() => cleanup.push(1));
    ctx.onDispose(() => cleanup.push(2)); throw new Error('setup failed'); }, { provides: ['x'] }));
  await assert.rejects(host.start(), /setup failed/);
  assert.deepEqual(cleanup, [2,1]); assert.throws(() => host.resolve('x')); assert.equal(host.status('bad'), 'failed');
});
test('cleanup continues even when a disposer throws', async () => {
  const host = new PluginHost(); let cleaned = false;
  host.install(plugin('p', ctx => { ctx.onDispose(() => { cleaned = true; }); ctx.onDispose(() => { throw new Error('cleanup'); }); }));
  await host.start(); await assert.rejects(host.stop('p'), AggregateError); assert.equal(cleaned, true);
});
test('undeclared services and omitted promised services fail closed', async () => {
  for (const setup of [ctx => ctx.provide('secret', 1), ctx => ctx.service('secret')]) {
    const host = new PluginHost(); host.install(plugin('p', setup));
    await assert.rejects(host.start(), { code: 'undeclared-service' });
  }
  const host = new PluginHost(); host.install(plugin('p', () => {}, { provides: ['never-provided'] }));
  await assert.rejects(host.start(), { code: 'missing-service' });
});
test('scope matching is segment-based, not a string prefix', async () => {
  const f = await fixture(); assert.equal(f.plugins.list(['tenant-a','R01','T1']).length, 1);
  for (const scope of [['tenant-b','R01'], ['tenant-a','R010'], ['tenant-a']]) assert.equal(f.plugins.list(scope).length, 0);
});
test('registration closes after setup; metadata mutations do not change an activation', async () => {
  const host = new PluginHost(); let context;
  const p = plugin('p', ctx => { context = ctx; }); host.install(p); p.manifest.id = 'renamed';
  await host.start(); assert.equal(host.status('p'), 'active');
  assert.throws(() => context.onDispose(() => {}), { code: 'closed-context' });
});
test('deactivation drains an accepted operation and reconciliation releases its lease', async () => {
  const f = await fixture({ capability: {
    execute: async () => ({ status: 'accepted', handle: 'remote-42', evidence: null }),
    reconcile: async () => ({ status: 'completed', evidence: { observed: true } }),
  } });
  const proposal = await f.hub.propose(intent());
  const result = await f.hub.execute(proposal.id, 'op-1', { live: true });
  assert.equal(result.record.status, 'pending');
  let stopped = false; const stop = f.plugins.stop('robot').then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false); assert.equal(f.plugins.status('robot'), 'draining');
  assert.equal(f.plugins.list(intent().scope).length, 0);
  const reconciled = await f.hub.reconcile(result.record.id); assert.equal(reconciled.record.status, 'verified');
  await stop; assert.equal(f.control.disposed, true);
});
test('reactivation invalidates previously issued proposals even at the same plugin version', async () => {
  const f = await fixture(); const proposal = await f.hub.propose(intent());
  await f.plugins.stop('robot'); await f.plugins.start();
  assert.equal((await f.hub.execute(proposal.id, 'op', { live: true })).kind, 'rejected');
  assert.equal(f.control.calls, 0);
});
