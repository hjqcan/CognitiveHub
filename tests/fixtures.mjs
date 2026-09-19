import { CognitiveHub, PluginHost, HumanInbox, MemoryJournal, MemoryEvents } from '../dist/index.js';
export const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
export const tick = () => new Promise(resolve => setImmediate(resolve));
export const intent = (changes = {}) => ({ id: 'task-1', revision: 1, scope: ['tenant-a', 'R01'],
  objective: 'Recover the blocked task using approved capabilities', constraints: ['Never bypass RMS'],
  capabilities: ['robot.recover@1'], ...changes });
export async function fixture(options = {}) {
  const control = { now: 1000, version: 'v1', allow: true, policyVersion: 'p1', calls: 0,
    verifyCalls: 0, disposed: false, ready: true };
  const capability = {
    id: 'robot.recover@1', description: 'Submit a recovery task to the existing host', effect: 'write',
    prepare: async () => [{ key: 'recover-r01', description: 'Request recovery of R01', input: { robotId: 'R01' }, resources: ['robot:R01'] }],
    validate: input => { if (!input || input.robotId !== 'R01') throw new Error('Invalid robot'); },
    check: async () => control.ready,
    execute: async () => { control.calls++; return { status: 'completed', evidence: { hostTask: 'H1' } }; },
    verify: async () => { control.verifyCalls++; return { status: 'verified', evidence: { taskState: 'done' } }; },
    ...options.capability,
  };
  const plugins = new PluginHost();
  plugins.install({ manifest: { apiVersion: 1, id: 'robot', version: options.pluginVersion ?? '1.0.0' },
    setup: ctx => { ctx.capability(capability); ctx.onDispose(() => { control.disposed = true; }); } }, options.scope ?? ['tenant-a', 'R01']);
  await plugins.start();
  const inbox = new HumanInbox(), events = new MemoryEvents(), journal = options.journal ?? new MemoryJournal();
  const hub = new CognitiveHub({ plugins, state: { observe: async () => ({ version: control.version,
    observedAt: control.now, validUntil: control.now + 10000, facts: { blocked: true } }) },
    decision: { name: 'fixture', decide: async request => ({ kind: 'action', candidateId: request.candidates[0].id }) },
    policy: { check: async () => ({ allowed: control.allow, version: control.policyVersion, reason: 'host policy' }) },
    deliberation: inbox, events, journal, now: () => control.now, ...options.hub });
  return { hub, plugins, inbox, events, journal, control, capability };
}
