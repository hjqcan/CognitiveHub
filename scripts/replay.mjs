// Read-only replay over exported JSON. Never constructs a hub, never dispatches an action.
//   node scripts/replay.mjs <dir> [--intent <id>] [--run <id>] [--limit <n>] [--labels <file>] [--reevaluate jev]
// <dir> holds decisions.json, journal.json and runs.json as exported by the memory stores' entries()
// (runs.json may also be the { runs, events } shape written by tests/runtime-worker.mjs).
// --labels <file> compares advisory decisions with what the host actually did: a JSON array of
// { decisionId, actual: { capability, key } | null } (see compareAdvice); it prints agreement, recall and the misses.
// --reevaluate jev sends every recorded decision request to TypeSafe and reports agreement; it needs TYPESAFE_AI_API_KEY.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareAdvice, MemoryDecisionStore, MemoryJournal, MemoryRunStore, reevaluate, timeline } from '../dist/index.js';

const [dir, ...rest] = process.argv.slice(2);
if (!dir) { console.error('Usage: node scripts/replay.mjs <dir> [--intent <id>] [--run <id>] [--limit <n>] [--labels <file>] [--reevaluate jev]'); process.exit(2); }
const flag = name => { const index = rest.indexOf(`--${name}`); return index >= 0 ? rest[index + 1] : undefined; };
const load = name => existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : null;

const decisions = new MemoryDecisionStore(load('decisions.json') ?? []);
const journal = new MemoryJournal(load('journal.json') ?? []);
const stored = load('runs.json');
const runs = new MemoryRunStore(Array.isArray(stored) ? stored : stored?.runs ?? [], Array.isArray(stored) ? [] : stored?.events ?? []);
const query = {
  ...(flag('intent') ? { intentId: flag('intent') } : {}), ...(flag('run') ? { runId: flag('run') } : {}),
  ...(flag('limit') ? { limit: Number(flag('limit')) } : {}),
};

const entries = await timeline({ decisions, journal, runs }, query);
for (const entry of entries) console.log(`${new Date(entry.at).toISOString()}  ${entry.kind.padEnd(11)} ${entry.id}  ${entry.summary}`);
console.log(`${entries.length} entries`);

if (flag('labels') !== undefined) {
  const labels = JSON.parse(readFileSync(flag('labels'), 'utf8'));
  const records = await decisions.list({
    ...(query.intentId ? { intentId: query.intentId } : {}), ...(query.runId ? { tag: { key: 'runId', value: query.runId } } : {}),
  });
  const c = compareAdvice(records, labels);
  const ratio = (n, d) => d ? `${n}/${d}` : 'n/a';
  console.log(`Advice labelled: ${c.labelled}`);
  console.log(`Agreement: ${ratio(c.agreed, c.labelled)}; differed ${c.differed}, abstained ${c.abstained}, overreach ${c.overreach}`);
  console.log(`Recall: ${c.recall === null ? 'n/a' : c.recall.toFixed(2)}`);
  for (const m of c.missing) console.log(`Missing candidate: ${m.decisionId} -> ${m.actual.capability}/${m.actual.key}`);
  if (c.unmatched.length) console.log(`Unmatched labels: ${c.unmatched.join(', ')}`);
}

if (flag('reevaluate') !== undefined) {
  if (flag('reevaluate') !== 'jev') throw new Error('Only --reevaluate jev is supported');
  const apiKey = process.env.TYPESAFE_AI_API_KEY;
  if (!apiKey) throw new Error('Set TYPESAFE_AI_API_KEY to re-evaluate recorded decisions with Jev (recorded state is sent to the API)');
  const { JevDecisionProvider } = await import('../dist/jev.js');
  const records = await decisions.list({
    ...(query.intentId ? { intentId: query.intentId } : {}), ...(query.runId ? { tag: { key: 'runId', value: query.runId } } : {}),
  });
  const results = await reevaluate(records, new JevDecisionProvider({ apiKey, model: process.env.JEV_MODEL ?? 'jev-1.13.0' }));
  for (const r of results) console.log(`${r.agrees ? 'agree   ' : 'disagree'} ${r.decisionId}  recorded=${JSON.stringify(r.recorded)} replayed=${JSON.stringify(r.replayed)}${r.code ? ` code=${r.code}` : ''}`);
  console.log(`${results.filter(r => r.agrees).length}/${results.length} agree`);
}
