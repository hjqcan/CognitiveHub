// Phase A shadowing, offline: the host's operator keeps handling incidents; an advisory run watches the same state,
// proposes and previews what it would do, and never dispatches. Afterwards the advice is compared with the operator's
// actual choices. Everything is synthetic and in memory: no network, no device, no credentials.
//   node examples/shadow-advisor.mjs [exportDir]     (exportDir: also write decisions.json and labels.json for the CLI)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareAdvice, HumanInbox, IntentRuntime, MemoryDecisionStore, PluginHost } from '../dist/index.js';

// What happened on the floor, and what the operator actually did about it.
const incidents = [
  { kind: 'blocked-path', operator: 'reroute' },
  { kind: 'dropped-load', operator: 'retry' },
  { kind: 'blocked-path', operator: 'retry' },
  { kind: 'sensor-fault', operator: 'call-technician' },   // no capability offers this: a recall miss, not a decider error
  { kind: 'dropped-load', operator: null },                // the operator let it be
  { kind: 'blocked-path', operator: 'reroute' },
];
const operatorCapability = key => key === 'call-technician' ? 'maintenance.call-technician@1' : 'robot.request-recovery@1';

const floor = { incident: null, seq: 0, dispatched: 0 };
const plugins = new PluginHost();
plugins.install({ manifest: { apiVersion: 1, id: 'shadow.recovery', version: '0.1.0' }, setup(ctx) {
  ctx.capability({ id: 'robot.request-recovery@1', description: 'Ask the existing platform to recover a blocked task', effect: 'write',
    async prepare({ observation }) {
      const keys = { 'blocked-path': ['reroute', 'retry'], 'dropped-load': ['retry'] }[observation.facts.incident] ?? [];
      return keys.map(key => ({ key, description: `Request ${key} for the current incident`, input: { recovery: key }, resources: ['robot:R01'] }));
    },
    validate(input) { if (!['reroute', 'retry'].includes(input?.recovery)) throw new Error('Unknown recovery'); },
    async check({ observation }) { return observation.facts.incident !== null; },
    async execute() { floor.dispatched++; return { status: 'accepted', handle: 'never', evidence: null }; },
    async verify() { return { status: 'pending', evidence: null }; } });
} }, ['plant-7', 'R01']);
await plugins.start();

// A deterministic stand-in for a model: reroute blocked paths, retry dropped loads.
const decider = { name: 'shadow-rules', async decide(request) {
  const incident = request.observation.facts.incident;
  const want = incident === 'blocked-path' ? 'reroute' : incident === 'dropped-load' ? 'retry' : null;
  const candidate = request.candidates.find(c => c.key === want);
  return candidate ? { kind: 'action', candidateId: candidate.id } : { kind: 'wait', reason: 'Nothing I would do here' };
} };
const decisions = new MemoryDecisionStore();
let now = 1_000_000;
const runtime = new IntentRuntime({ plugins, decisions, decision: decider, deliberation: new HumanInbox(), owner: 'shadow', now: () => now,
  state: { async observe() { return { version: `incident-${floor.seq}`, observedAt: now, validUntil: now + 60000, facts: { incident: floor.incident } }; } },
  policy: { async check() { return { allowed: true, version: 'shadow-policy', reason: 'Advisory only; nothing is dispatched' }; } },
  goal: { async evaluate() { return { status: 'unsatisfied', evidence: null }; } } });
const run = await runtime.start({ approval: 'advisory', idle: 'wait', waitMs: 60000,
  intent: { id: 'shadow-recovery', revision: 1, scope: ['plant-7', 'R01'], objective: 'Advise on recovering blocked tasks',
    constraints: ['Advice only: the operator decides'], capabilities: ['robot.request-recovery@1'] },
  budget: { maxDecisions: 100, maxActions: 1, maxNoProgress: 5, deadlineAt: null } });

const labels = [];
let advised = 0;
for (const incident of incidents) {
  floor.incident = incident.kind; floor.seq++; now += 1000;           // the host observes a new incident
  const step = await runtime.step(run.id);
  if (step.outcome === 'advised') advised++;
  labels.push({ decisionId: step.decisionId,
    actual: incident.operator === null ? null : { capability: operatorCapability(incident.operator), key: incident.operator } });
}
await runtime.stop(run.id);

const c = compareAdvice(await decisions.list({ tag: { key: 'runId', value: run.id } }), labels);
console.log(`Advised: ${advised} of ${incidents.length} incidents`);
console.log(`Dispatched: ${floor.dispatched}`);
console.log(`Agreement: ${c.agreed}/${c.labelled} (differed ${c.differed}, abstained ${c.abstained}, overreach ${c.overreach})`);
console.log(`Recall: ${(c.recall * 100).toFixed(0)}% of the operator's actions were candidates`);
for (const m of c.missing) console.log(`Missing candidate: ${m.actual.capability}/${m.actual.key}`);

const dir = process.argv[2];
if (dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'decisions.json'), JSON.stringify(decisions.entries()));
  writeFileSync(join(dir, 'labels.json'), JSON.stringify(labels));
  console.log(`Exported to ${dir}`);
}
await plugins.stop('shadow.recovery');
