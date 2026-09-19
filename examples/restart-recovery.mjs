import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CognitiveHub, PluginHost, HumanInbox, MemoryJournal } from '../dist/index.js';

// A simulated crash and restart. Two runs share one directory; nothing here touches a network or a device.
//   node examples/restart-recovery.mjs <dir> submit    dispatch, save the journal, exit without stopping the plugin
//   node examples/restart-recovery.mjs <dir> recover   rebuild the journal, settle the open operation by query only
const [dir, phase] = process.argv.slice(2);
if (!dir || !['submit', 'recover'].includes(phase)) throw new Error('Usage: restart-recovery.mjs <dir> submit|recover');
mkdirSync(dir, { recursive: true });
const load = (name, fallback) => existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : fallback;
const save = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2));

// The "external platform" lives in a file so it outlives the crashed process. It deduplicates by idempotency key.
const platform = load('host-tasks.json', { submissions: 0, tasks: {} });
const gateway = {
  async submit({ robotId, idempotencyKey }) {
    if (!platform.tasks[idempotencyKey]) { platform.submissions++; platform.tasks[idempotencyKey] = { robotId, status: 'running' }; }
    save('host-tasks.json', platform);
    return { status: 'accepted', handle: idempotencyKey, evidence: { simulated: true } };
  },
  async query(key) {
    const task = platform.tasks[key];
    if (!task) return { status: 'unknown', reason: 'No task recorded for this key' };
    return task.status === 'done' ? { status: 'completed', evidence: { simulated: true } } : { status: 'accepted', handle: key, evidence: { simulated: true } };
  },
};

const plugins = new PluginHost();
plugins.install({
  manifest: { apiVersion: 1, id: 'demo.recovery', version: '0.1.0' },
  setup(ctx) {
    ctx.capability({
      id: 'robot.request-recovery@1', description: 'Ask the existing platform to recover a blocked task', effect: 'write',
      async prepare({ observation }) {
        if (!observation.facts.blocked) return [];
        return [{ key: 'r01-recover', description: 'Request the approved R01 recovery workflow', input: { robotId: 'R01' }, resources: ['robot:R01'] }];
      },
      validate(input) { if (input?.robotId !== 'R01') throw new Error('Unsupported robot'); },
      async check({ observation }) { return observation.facts.blocked === true; },
      async execute({ action, idempotencyKey }) { return gateway.submit({ ...action.input, idempotencyKey }); },
      async reconcile({ idempotencyKey }) { return gateway.query(idempotencyKey); },
      async verify({ idempotencyKey }) {
        const task = platform.tasks[idempotencyKey];
        return { status: task?.status === 'done' ? 'verified' : 'pending', evidence: { simulated: true, taskState: task?.status ?? 'missing' } };
      },
    });
  },
}, ['demo-tenant', 'R01']);
await plugins.start();

// The journal is rebuilt from exported JSON. Records name their plugin and version, not a process-local activation.
const journal = new MemoryJournal(load('journal.json', []));
const hub = new CognitiveHub({
  plugins, journal, deliberation: new HumanInbox(),
  decision: { name: 'deterministic-demo', async decide(request) { return { kind: 'action', candidateId: request.candidates[0].id }; } },
  state: { async observe() { const now = Date.now(); return { version: 'scene-1', observedAt: now, validUntil: now + 30000, facts: { blocked: true } }; } },
  policy: { async check({ action }) {
    return { allowed: action.capability === 'robot.request-recovery@1', version: 'demo-policy-1', reason: 'Synthetic demo authorization only' };
  } },
});

if (phase === 'submit') {
  const proposal = await hub.propose({
    id: 'recover-task-42', revision: 1, scope: ['demo-tenant', 'R01'],
    objective: 'Recover the blocked task through the existing platform',
    constraints: ['No direct device commands'], capabilities: ['robot.request-recovery@1'],
  });
  if (proposal.kind !== 'proposal') throw new Error(`Expected a proposal, got ${proposal.kind}`);
  const submitted = await hub.execute(proposal.id, 'recovery-attempt-1', { live: true });
  if (submitted.kind !== 'record') throw new Error(submitted.reason);
  console.log('Submitted:', submitted.record.status);
  save('journal.json', journal.entries());
  // Crash: exit while the operation is open and the plugin is still leased. Nothing is stopped or drained.
  process.exit(0);
}

// Recover: the platform finished the task while this process was down. Query and verify; never resubmit.
for (const task of Object.values(platform.tasks)) task.status = 'done';
save('host-tasks.json', platform);
for (const record of await journal.unsettled()) {
  const result = await hub.reconcile(record.id);
  console.log('Recovered:', result.kind === 'record' ? result.record.status : `${result.kind} (${result.code})`);
}
console.log('Submissions:', platform.submissions);
save('journal.json', journal.entries());
await plugins.stop('demo.recovery');
