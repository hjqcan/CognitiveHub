// Per-step cost of IntentRuntime as one run accumulates actions. Offline: no network, no device.
//   node scripts/bench-step.mjs [actions=2000] [--pg]      (run `npm run build` first; --pg uses PGlite)
// Prints, at a few milestones, the average step time over the last 10 steps and the per-step counts of journal reads,
// run writes and SQL statements. The counts are the portable signal; the times depend on the machine.
import { HumanInbox, IntentRuntime, MemoryJournal, MemoryRunStore, PluginHost } from '../dist/index.js';

const total = Number(process.argv.find(a => /^\d+$/.test(a)) ?? 2000);
const usePg = process.argv.includes('--pg');
const counts = { get: 0, write: 0, sql: 0 };
let version = 0, now = 1_000_000;

let journal = new MemoryJournal(), runs = new MemoryRunStore(), db = null;
if (usePg) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { migrate, PgJournal, PgRunStore } = await import('../dist/pg.js');
  db = new PGlite();
  const client = { query: (text, values) => { counts.sql++; return db.query(text, values ? [...values] : []); } };
  await migrate(client);
  journal = new PgJournal(client); runs = new PgRunStore(client);
}
const count = (object, method, key) => { const f = object[method].bind(object); object[method] = async (...a) => { counts[key]++; return f(...a); }; };
count(journal, 'get', 'get'); count(runs, 'replace', 'write');

const plugins = new PluginHost();
plugins.install({ manifest: { apiVersion: 1, id: 'bench', version: '1.0.0' }, setup(ctx) {
  ctx.capability({ id: 'bench.act@1', description: 'Advance the counter', effect: 'write',
    async prepare() { return [{ key: 'advance', description: 'Advance', input: { n: 1 }, resources: ['counter'] }]; },
    validate() {}, async check() { return true; },
    async execute() { version++; return { status: 'completed', evidence: { v: version } }; },
    async verify() { return { status: 'verified', evidence: { v: version } }; } });
} }, ['bench']);
await plugins.start();
const runtime = new IntentRuntime({ plugins, journal, runs, owner: 'bench', now: () => now, deliberation: new HumanInbox(),
  state: { async observe() { return { version: `v${version}`, observedAt: now, validUntil: now + 60000, facts: { version } }; } },
  decision: { name: 'first', async decide(r) { return { kind: 'action', candidateId: r.candidates[0].id }; } },
  policy: { async check() { return { allowed: true, version: 'p', reason: 'benchmark' }; } },
  goal: { async evaluate() { return { status: version >= total ? 'satisfied' : 'unsatisfied', evidence: null }; } } });
const run = await runtime.start({ approval: 'automatic',
  intent: { id: 'bench', revision: 1, scope: ['bench'], objective: 'Advance the counter', constraints: [], capabilities: ['bench.act@1'] },
  budget: { maxDecisions: total * 2, maxActions: total * 2, maxNoProgress: 5, deadlineAt: null } });

const marks = new Set([10, 100, 250, 500, 1000, 2000, 4000, 8000].filter(x => x <= total));
const window = [];
console.log(`${usePg ? 'PGlite' : 'memory'} stores, ${total} actions`);
console.log('actions  ms/step(avg of 10)  journal reads/step  run writes/step  SQL/step');
for (let i = 1; i <= total; i++) {
  const before = { ...counts }, t = performance.now();
  const result = await runtime.step(run.id); now += 10;
  window.push(performance.now() - t); if (window.length > 10) window.shift();
  if (result.outcome !== 'executed') throw new Error(`step ${i} ended ${result.outcome}`);
  if (marks.has(i)) {
    const avg = window.reduce((a, b) => a + b, 0) / window.length;
    console.log(`${String(i).padStart(7)}  ${avg.toFixed(3).padStart(18)}  ${String(counts.get - before.get).padStart(18)}  ` +
      `${String(counts.write - before.write).padStart(15)}  ${String(counts.sql - before.sql).padStart(8)}`);
  }
}
const final = await runtime.step(run.id);
console.log(`final: ${final.outcome}; run snapshot ${JSON.stringify(final.run).length} bytes`);
await plugins.stop('bench'); await db?.close();
