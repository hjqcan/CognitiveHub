import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HumanInbox, IntentRuntime, MemoryJournal, MemoryRunStore } from '../dist/index.js';
import { createPlatform, simulatedHost, spec } from './runtime-host.mjs';

// One worker process for the kill test. It loads every store from <dir>, steps its run until it waits or ends,
// and exits. The test edits platform.json between spawns and SIGKILLs one spawn mid-dispatch.
const dir = process.argv[2];
const path = name => join(dir, name);
const load = (name, fallback) => existsSync(path(name)) ? JSON.parse(readFileSync(path(name), 'utf8')) : fallback;
const save = (name, value) => writeFileSync(path(name), JSON.stringify(value));
const platform = load('platform.json', createPlatform());

// Every store write reaches disk before the runtime continues, so a SIGKILL leaves a consistent snapshot.
class FileJournal extends MemoryJournal {
  async claim(record) { const claim = await super.claim(record); save('journal.json', this.entries()); return claim; }
  async replace(record, expected) { await super.replace(record, expected); save('journal.json', this.entries()); }
}
class FileRunStore extends MemoryRunStore {
  flush() { save('runs.json', { runs: this.entries(), events: this.events() }); }
  async create(run) { await super.create(run); this.flush(); }
  async replace(run, expected) { await super.replace(run, expected); this.flush(); }
  async markEvent(runId, key) { const first = await super.markEvent(runId, key); this.flush(); return first; }
}
const stored = load('runs.json', { runs: [], events: [] });
const host = simulatedHost(platform, { onSubmit: key => { save('platform.json', platform); console.log('submitted', key); } });
await host.plugins.start();
const runtime = new IntentRuntime({
  plugins: host.plugins, state: host.state, policy: host.policy, decision: host.decision, goal: host.goal, deliberation: new HumanInbox(),
  journal: new FileJournal(load('journal.json', [])), runs: new FileRunStore(stored.runs, stored.events),
  owner: 'kill-test-worker', // The same worker identity restarts, so it may take over its own lease.
});
let [run] = await runtime.runs.unsettled();
if (!run) run = await runtime.start(spec());
for (let i = 0; i < 8; i++) {
  const result = await runtime.step(run.id);
  console.log('step:', result.outcome, result.run.status);
  if (result.outcome !== 'executed' && result.outcome !== 'rejected') break;
}
save('platform.json', platform);
console.log('submissions:', platform.submissions);
process.exit(0); // Do not drain the plugin: an open operation would keep it leased, like a real service exiting.
