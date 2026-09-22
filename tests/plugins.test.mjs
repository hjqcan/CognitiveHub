import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginHost } from '../dist/index.js';
import { deferred, fixture, intent, tick } from './fixtures.mjs';
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

for (const fail of [false, true]) test(`a staged batch is hidden until commit, including when rollback is ${fail}`, async () => {
  const f = await fixture(), host = f.plugins, entered = deferred(), gate = deferred();
  let disposed = false;
  host.install(plugin('staged', ctx => {
    ctx.provide('staged.v1', 42); ctx.capability(f.capability);
    ctx.onDispose(() => { disposed = true; });
  }, { provides: ['staged.v1'] }));
  host.install(plugin('consumer', async ctx => {
    assert.equal(ctx.service('staged.v1'), 42);
    entered.resolve(); await gate.promise;
    if (fail) throw new Error('later setup failed');
  }, { requires: ['staged.v1'] }));
  const start = host.start();
  const completed = fail ? assert.rejects(start, /later setup failed/) : start;
  await entered.promise;
  try {
    assert.equal(host.status('staged'), 'starting');
    assert.throws(() => host.resolve('staged.v1'), { code: 'missing-service' });
    assert.deepEqual(host.list(intent().scope).map(r => r.pluginId), ['robot']);
    assert.throws(() => host.acquire('staged', f.capability.id, 1, intent().scope), { code: 'unavailable-capability' });
    const p = await f.hub.propose(intent());
    assert.equal((await f.hub.execute(p.id, 'existing-plugin', { live: true })).record.status, 'verified');
  } finally { gate.resolve(); await completed; }
  assert.equal(disposed, fail);
  assert.equal(host.status('staged'), fail ? 'stopped' : 'active');
  assert.equal(host.status('robot'), 'active');
  if (!fail) {
    assert.equal(host.resolve('staged.v1'), 42);
    await host.stop('consumer'); await host.stop('staged');
  }
  await host.stop('robot');
});

test('new consumers and saved contexts cannot resolve a draining provider', async () => {
  const f = await fixture(), host = new PluginHost(); let context, consumerStarted = false;
  host.install(plugin('provider', ctx => {
    context = ctx; ctx.provide('service.v1', 42); ctx.capability(f.capability);
  }, { provides: ['service.v1'] }));
  await host.start();
  const registration = host.list(intent().scope)[0];
  const lease = host.acquire('provider', f.capability.id, registration.activation, intent().scope);
  const stop = host.stop('provider');
  try {
    assert.throws(() => context.service('service.v1'), { code: 'missing-service' });
    host.install(plugin('consumer', ctx => {
      ctx.service('service.v1'); consumerStarted = true;
    }, { requires: ['service.v1'] }));
    await assert.rejects(host.start(), { code: 'missing-dependency' });
    assert.equal(consumerStarted, false);
  } finally { lease.release(); await stop; }
  await host.start();
  assert.equal(consumerStarted, true);
  await host.stop('consumer'); await host.stop('provider'); await f.plugins.stop('robot');
});

test('async cleanup retains dependency protection and prevents reactivation', async () => {
  const host = new PluginHost(), entered = deferred(), gate = deferred();
  const service = { disposed: false }; let activations = 0;
  host.install(plugin('provider', ctx => {
    ctx.provide('service.v1', service); ctx.onDispose(() => { service.disposed = true; });
  }, { provides: ['service.v1'] }));
  host.install(plugin('consumer', ctx => {
    activations++; const dependency = ctx.service('service.v1');
    ctx.onDispose(async () => {
      entered.resolve(); await gate.promise; assert.equal(dependency.disposed, false);
    });
  }, { requires: ['service.v1'] }));
  await host.start(); const stop = host.stop('consumer'); await entered.promise;
  try {
    assert.equal(host.status('consumer'), 'draining');
    await assert.rejects(host.stop('provider'), { code: 'active-dependent' });
    await host.start(); assert.equal(activations, 1);
  } finally { gate.resolve(); await stop; }
  assert.equal(host.status('consumer'), 'stopped');
  await host.stop('provider'); assert.equal(service.disposed, true);
});

test('rollback cleanup failure marks the unpublished plugin failed', async () => {
  const host = new PluginHost();
  host.install(plugin('first', ctx => {
    ctx.provide('first.v1', 42); ctx.onDispose(() => { throw new Error('cleanup failed'); });
  }, { provides: ['first.v1'] }));
  host.install(plugin('later', () => { throw new Error('setup failed'); }));
  await assert.rejects(host.start(), AggregateError);
  assert.equal(host.status('first'), 'failed');
  assert.throws(() => host.resolve('first.v1'), { code: 'missing-service' });
});

for (const fail of [false, true]) test(`staged services can resolve dependencies during setup and cleanup (rollback=${fail})`, async () => {
  const host = new PluginHost(); let cleaned = false;
  host.install(plugin('base', ctx => ctx.provide('base.v1', 42), { provides: ['base.v1'] }));
  host.install(plugin('forward', ctx => ctx.provide('forward.v1', () => ctx.service('base.v1')),
    { requires: ['base.v1'], provides: ['forward.v1'] }));
  host.install(plugin('consumer', ctx => {
    assert.equal(ctx.service('forward.v1')(), 42);
    ctx.onDispose(() => { assert.equal(ctx.service('forward.v1')(), 42); cleaned = true; });
    if (fail) throw new Error('consumer failed');
  }, { requires: ['forward.v1'] }));
  if (fail) await assert.rejects(host.start(), /consumer failed/);
  else { await host.start(); await host.stop('consumer'); await host.stop('forward'); await host.stop('base'); }
  assert.equal(cleaned, true);
});

test('inactive plugins can be uninstalled; a failed module no longer blocks the next activation', async () => {
  const host = new PluginHost(); let boots = 0;
  host.install(plugin('healthy', () => {}));
  host.install(plugin('flaky', () => { if (++boots === 1) throw new Error('boot failed'); }));
  await assert.rejects(host.start(), /boot failed/);
  assert.equal(host.status('flaky'), 'failed'); assert.equal(host.status('healthy'), 'stopped');
  host.uninstall('flaky'); await host.start();
  assert.equal(host.status('flaky'), undefined); assert.equal(host.status('healthy'), 'active');
  assert.throws(() => host.uninstall('healthy'), { code: 'plugin-state' });
  host.install(plugin('flaky', () => { boots++; })); await host.start();
  assert.equal(host.status('flaky'), 'active'); assert.equal(boots, 2);
  await host.stop('flaky'); host.uninstall('flaky'); await host.stop('healthy');
});

test('rebind leases the active activation of an exact plugin version', async () => {
  const f = await fixture(), scope = intent().scope, id = f.capability.id;
  await f.plugins.stop('robot'); await f.plugins.start();
  const lease = f.plugins.rebind('robot', '1.0.0', id, scope);
  assert.equal(lease.registration.activation, 2);
  assert.throws(() => f.plugins.rebind('robot', '2.0.0', id, scope), { code: 'plugin-version-mismatch' });
  assert.throws(() => f.plugins.rebind('robot', '1.0.0', id, ['tenant-b', 'R01']), { code: 'unavailable-capability' });
  assert.throws(() => f.plugins.rebind('missing', '1.0.0', id, scope), { code: 'unavailable-capability' });
  let stopped = false; const stop = f.plugins.stop('robot').then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  assert.throws(() => f.plugins.rebind('robot', '1.0.0', id, scope), { code: 'unavailable-capability' });
  lease.release(); await stop; assert.equal(stopped, true);
});

test('stop can give up waiting for leases on a signal and resume later', async () => {
  const f = await fixture(), host = new PluginHost();
  host.install(plugin('provider', ctx => { ctx.capability(f.capability); }));
  await host.start();
  const registration = host.list(intent().scope)[0];
  const lease = host.acquire('provider', f.capability.id, registration.activation, intent().scope);
  const controller = new AbortController();
  const stop = host.stop('provider', { signal: controller.signal });
  await tick(); assert.equal(host.status('provider'), 'draining');
  controller.abort();
  await assert.rejects(stop, { code: 'drain-aborted' });
  assert.equal(host.status('provider'), 'draining', 'giving up does not reactivate or kill anything');
  assert.equal(host.list(intent().scope).length, 0);
  assert.throws(() => host.acquire('provider', f.capability.id, registration.activation, intent().scope), { code: 'unavailable-capability' });
  await assert.rejects(host.stop('provider', { signal: AbortSignal.abort() }), { code: 'drain-aborted' });
  const resumed = host.stop('provider'); const twice = host.stop('provider');
  await tick(); lease.release();
  await resumed; await twice;
  assert.equal(host.status('provider'), 'stopped');
  host.uninstall('provider');
});
