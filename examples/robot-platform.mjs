import { CognitiveHub, PluginHost, HumanInbox, MemoryEvents } from '../dist/index.js';
import { jevPlugin } from '../dist/jev.js';

// No hardware, wallet, external task system, or credentials are involved by default.
const hostTasks = new Map();
const hostGateway = {
  async submit({ robotId, expectedVersion, idempotencyKey }) {
    if (expectedVersion !== 'scene-1') throw new Error('Host rejected a stale scene');
    if (!hostTasks.has(idempotencyKey)) hostTasks.set(idempotencyKey, { robotId, status: 'running' });
    return { status: 'accepted', handle: idempotencyKey, evidence: { simulated: true } };
  },
  async query(key) {
    const task = hostTasks.get(key);
    return task?.status === 'done'
      ? { status: 'completed', evidence: { robotId: task.robotId, simulated: true } }
      : { status: 'accepted', handle: key, evidence: { simulated: true } };
  },
};

const plugins = new PluginHost();
// Deliberately install the consumer before its dependency.
plugins.install({
  manifest: { apiVersion: 1, id: 'gurki.recovery', version: '0.1.0', requires: ['host.tasks.v1'] },
  setup(ctx) {
    const gateway = ctx.service('host.tasks.v1');
    ctx.capability({
      id: 'robot.request-recovery@1', description: 'Ask the existing platform to recover a blocked task', effect: 'write',
      async prepare({ observation }) {
        if (!observation.facts.blocked) return [];
        return [{ key: 'r01-recover', description: 'Request the approved R01 recovery workflow',
          input: { robotId: 'R01' }, resources: ['robot:R01'] }];
      },
      validate(input) { if (input?.robotId !== 'R01') throw new Error('Unsupported robot'); },
      async check({ observation }) { return observation.facts.blocked === true; },
      async execute({ action, observation, idempotencyKey }) {
        return gateway.submit({ ...action.input, expectedVersion: observation.version, idempotencyKey });
      },
      async reconcile({ idempotencyKey }) { return gateway.query(idempotencyKey); },
      async verify({ idempotencyKey }) {
        const task = hostTasks.get(idempotencyKey);
        return { status: task?.status === 'done' ? 'verified' : 'pending', evidence: { simulated: true, taskState: task?.status ?? 'missing' } };
      },
    });
  },
}, ['demo-tenant', 'R01']);
plugins.install({
  manifest: { apiVersion: 1, id: 'demo.host', version: '0.1.0', provides: ['host.tasks.v1'] },
  setup: ctx => ctx.provide('host.tasks.v1', hostGateway),
});

if (process.argv.includes('--jev')) {
  // Opt-in only: sends this synthetic state to the paid external API.
  const apiKey = process.env.TYPESAFE_AI_API_KEY;
  if (!apiKey) throw new Error('Set TYPESAFE_AI_API_KEY before using --jev');
  plugins.install(jevPlugin({ apiKey, model: process.env.JEV_MODEL ?? 'jev-1.13.0' }));
} else {
  plugins.install({
    manifest: { apiVersion: 1, id: 'demo.decision', version: '0.1.0', provides: ['decision.v1'] },
    setup: ctx => ctx.provide('decision.v1', {
      name: 'deterministic-demo',
      async decide(request) { return { kind: 'action', candidateId: request.candidates[0].id }; },
    }),
  });
}
await plugins.start();
const inbox = new HumanInbox(), events = new MemoryEvents();
const hub = new CognitiveHub({
  plugins, decision: plugins.resolve('decision.v1'), deliberation: inbox, events,
  state: { async observe() { const now = Date.now();
    return { version: 'scene-1', observedAt: now, validUntil: now + 30000, facts: { blocked: true } }; } },
  policy: { async check({ intent, action }) {
    return { allowed: intent.revision === 1 && action.scope[0] === 'demo-tenant' &&
      action.capability === 'robot.request-recovery@1', version: 'demo-policy-1', reason: 'Synthetic demo authorization only' };
  } },
});
const intent = {
  id: 'recover-task-42', revision: 1, scope: ['demo-tenant', 'R01'],
  objective: 'Recover the blocked task through the existing platform',
  constraints: ['No direct device commands', 'Do not modify unrelated tasks'],
  capabilities: ['robot.request-recovery@1'],
};
const proposal = await hub.propose(intent);
console.log('Decision:', proposal.kind);
if (proposal.kind === 'proposal') {
  console.log('Default:', (await hub.execute(proposal.id, 'recovery-attempt-1')).kind);
  // live means dispatch to our IN-MEMORY simulation here, not real hardware.
  const submitted = await hub.execute(proposal.id, 'recovery-attempt-1', { live: true });
  if (submitted.kind !== 'record') throw new Error(submitted.reason);
  console.log('Submitted:', submitted.record.status);
  hostTasks.get(submitted.record.id).status = 'done'; // Simulated host feedback.
  const checked = await hub.reconcile(submitted.record.id);
  console.log('Verified:', checked.record.status);
  console.log('Retry unchanged:', (await hub.execute(proposal.id, 'recovery-attempt-1', { live: true })).unchanged);
}
console.log('Human requests:', inbox.pending().length, 'Events:', events.entries().length);
await plugins.stop('gurki.recovery');
await plugins.stop('demo.host');
await plugins.stop(process.argv.includes('--jev') ? 'cognitive.jev' : 'demo.decision');
