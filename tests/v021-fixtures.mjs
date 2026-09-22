import { IntentRuntime } from '../dist/runtime.js';
import { PluginHost } from '../dist/plugins.js';
import { HumanInbox, MemoryJournal, MemoryRunStore } from '../dist/memory.js';

export const spec = (changes = {}) => ({
  intent: { id: 'goal', revision: 1, scope: ['tenant', 'device'], objective: 'Reach the goal',
    constraints: ['Respect host authorization'], capabilities: ['test.act@1'] },
  budget: { maxDecisions: 100, maxActions: 100, maxNoProgress: 20, deadlineAt: null },
  approval: 'automatic', waitMs: 20, ...changes,
});
export function capabilityPlugin(control, version = '1.0.0') {
  return {
    manifest: { apiVersion: 1, id: 'test.plugin', version },
    setup(ctx) {
      ctx.capability({
        id: 'test.act@1', description: 'Perform one bounded host action', effect: 'write',
        async prepare() { return [{ key: 'next', description: 'Perform the approved step', input: { step: 1 }, resources: ['device'] }]; },
        validate(input) { if (input?.step !== 1) throw new Error('Invalid input'); },
        async check() { await control.preflight?.(); return true; },
        async execute(context) {
          control.calls++; control.contexts.push(context);
          return control.accepted ? { status: 'accepted', handle: context.idempotencyKey, evidence: null }
            : { status: 'completed', evidence: null };
        },
        async reconcile() { return control.done ? { status: 'completed', evidence: null }
          : { status: 'accepted', handle: 'existing', evidence: null }; },
        async verify() { return { status: !control.accepted || control.done ? 'verified' : 'pending', evidence: { done: control.done } }; },
      });
    },
  };
}
export async function fixture(options = {}) {
  const control = options.control ?? { now: 1000, version: 's1', calls: 0, contexts: [], accepted: false, done: false, mode: 'action' };
  const plugins = options.plugins ?? new PluginHost();
  if (!options.empty) { plugins.install(capabilityPlugin(control)); await plugins.start(); }
  const runs = options.runs ?? new MemoryRunStore(), journal = options.journal ?? new MemoryJournal();
  const inbox = options.inbox ?? new HumanInbox();
  const runtime = new IntentRuntime({ plugins, runs, journal, owner: 'test-owner', waitMs: 20,
    now: () => control.now, deliberation: inbox,
    state: { async observe() { return { version: control.version, observedAt: 1000, validUntil: 1000000, facts: { done: control.done } }; } },
    decision: { name: 'deterministic-test', async decide(request) {
      await control.deciding?.();
      return control.mode === 'action' ? { kind: 'action', candidateId: request.candidates[0].id }
        : control.mode === 'wait' ? { kind: 'wait', reason: 'No new information' }
          : { kind: 'deliberate', reason: 'Need human judgment' };
    } },
    goal: { async evaluate() { return { status: 'unsatisfied', evidence: null }; } },
    policy: { async check() { return { allowed: true, version: 'p1', reason: 'Approved test scope' }; } },
    ...options.runtime,
  });
  return { runtime, control, plugins, runs, journal, inbox };
}
