import { HumanInbox, IntentRuntime, MemoryEvents, PluginHost } from '../dist/index.js';

// A generic simulated host, deliberately free of any robot or product vocabulary:
// a workflow with three stages, a task system keyed by idempotency key, and one fact the last stage needs.
export const createPlatform = () => ({ stage: 0, info: null, tasks: {}, submissions: 0, loseReceipt: false, hang: false });

export function simulatedHost(platform, { now = () => Date.now(), pluginVersion = '1.0.0', onSubmit } = {}) {
  const plugins = new PluginHost();
  plugins.install({ manifest: { apiVersion: 1, id: 'sim', version: pluginVersion }, setup(ctx) {
    ctx.capability({
      id: 'sim.advance@1', description: 'Advance the simulated workflow by one stage', effect: 'write',
      async prepare({ observation }) {
        const { stage, info } = observation.facts;
        if (stage >= 3 || (stage === 2 && !info)) return [];
        return [{ key: `to-${stage + 1}`, description: `Advance to stage ${stage + 1}`, input: { to: stage + 1 }, resources: ['workflow'] }];
      },
      validate(input) { if (!Number.isInteger(input?.to) || input.to < 1 || input.to > 3) throw new Error('Invalid stage'); },
      async check({ observation, action }) { return observation.facts.stage === action.input.to - 1; },
      async execute({ action, idempotencyKey }) {
        if (!platform.tasks[idempotencyKey]) {
          platform.tasks[idempotencyKey] = { to: action.input.to, status: 'running' }; platform.submissions++;
          onSubmit?.(idempotencyKey);
        }
        if (platform.hang) await new Promise(() => {});
        if (platform.loseReceipt) throw new Error('reply lost');
        return { status: 'accepted', handle: idempotencyKey, evidence: null };
      },
      async reconcile({ idempotencyKey }) {
        const task = platform.tasks[idempotencyKey];
        if (!task) return { status: 'unknown', reason: 'No task for this key' };
        return task.status === 'done' ? { status: 'completed', evidence: { to: task.to } } : { status: 'accepted', handle: idempotencyKey, evidence: null };
      },
      async verify({ idempotencyKey, action }) {
        const task = platform.tasks[idempotencyKey];
        const done = task?.status === 'done' && platform.stage >= action.input.to;
        return { status: done ? 'verified' : 'pending', evidence: { taskState: task?.status ?? 'missing', stage: platform.stage } };
      },
    });
  } }, ['sim-tenant']);
  const state = { async observe() {
    const t = now();
    return { version: `stage-${platform.stage}-${platform.info ?? 'none'}`, observedAt: t, validUntil: t + 60000, facts: { stage: platform.stage, info: platform.info } };
  } };
  const policy = { async check({ action }) { return { allowed: action.capability === 'sim.advance@1', version: 'sim-policy-1', reason: 'simulated' }; } };
  const decision = { name: 'first-candidate', async decide(request) { return { kind: 'action', candidateId: request.candidates[0].id }; } };
  const goal = { async evaluate({ observation }) {
    const { stage } = observation.facts;
    return { status: stage >= 3 ? 'satisfied' : 'unsatisfied', evidence: { stage }, progress: { stage } };
  } };
  // The external system finishes whatever is running; the test decides when.
  const complete = () => { for (const task of Object.values(platform.tasks)) if (task.status === 'running') { task.status = 'done'; platform.stage = Math.max(platform.stage, task.to); } };
  return { plugins, state, policy, decision, goal, complete };
}

export const spec = (changes = {}) => ({
  intent: { id: 'workflow-1', revision: 1, scope: ['sim-tenant'], objective: 'Reach stage 3', constraints: [], capabilities: ['sim.advance@1'] },
  budget: { maxDecisions: 20, maxActions: 10, maxNoProgress: 3, deadlineAt: null }, approval: 'automatic', ...changes,
});

/** A runtime over the simulated host with a controllable clock. Pass journal/runs to rebuild from a snapshot. */
export async function boot(platform, options = {}) {
  const clock = options.clock ?? { now: 1_000_000 };
  const host = simulatedHost(platform, { now: () => clock.now, pluginVersion: options.pluginVersion ?? '1.0.0', onSubmit: options.onSubmit });
  await host.plugins.start();
  const inbox = new HumanInbox(), events = new MemoryEvents();
  const runtime = new IntentRuntime({
    plugins: host.plugins, state: host.state, policy: options.policy ?? host.policy, decision: options.decision ?? host.decision,
    deliberation: inbox, goal: options.goal ?? host.goal, events, now: () => clock.now,
    ...(options.journal ? { journal: options.journal } : {}), ...(options.runs ? { runs: options.runs } : {}),
    ...(options.owner ? { owner: options.owner } : {}), ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
    ...(options.decisions ? { decisions: options.decisions } : {}),
  });
  return { runtime, host, inbox, events, clock, platform };
}
