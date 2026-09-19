import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDecisionStore, reevaluate, timeline } from '../dist/index.js';
import { boot, createPlatform, spec } from './runtime-host.mjs';

test('decision records tie a run to its execution records; the timeline and the CLI read them back without executing', async () => {
  const platform = createPlatform(); platform.info = 'given';
  const decisions = new MemoryDecisionStore();
  const { runtime, host, clock } = await boot(platform, { decisions });
  const run = await runtime.start(spec());
  for (let i = 0; i < 3; i++) { clock.now += 1000; await runtime.step(run.id); host.complete(); }
  clock.now += 1000;
  const done = await runtime.step(run.id); assert.equal(done.outcome, 'completed');

  const records = await decisions.list({ tag: { key: 'runId', value: run.id } });
  assert.equal(records.length, 3);
  assert.ok(records.every(r => r.outcome === 'proposal' && r.request.candidates.length === 1 && r.tags.runId === run.id));
  assert.deepEqual(records.map(r => r.recordId), done.run.operations);

  const entries = await timeline({ decisions, journal: runtime.hub.journal, runs: runtime.runs }, { runId: run.id });
  assert.deepEqual(entries.map(e => e.kind),
    ['run.started', 'decision', 'execution', 'decision', 'execution', 'decision', 'execution', 'run.ended']);
  assert.match(entries[1].summary, /proposal by first-candidate/); assert.match(entries[2].summary, /sim\.advance@1 verified/);
  assert.match(entries.at(-1).summary, /^completed/);

  const contrarian = { name: 'contrarian', async decide() { return { kind: 'wait', reason: 'no' }; } };
  const replayed = await reevaluate(records, contrarian);
  assert.equal(replayed.length, 3); assert.ok(replayed.every(r => r.agrees === false && r.replayed.kind === 'wait' && r.code === null));
  assert.ok((await reevaluate(records, host.decision)).every(r => r.agrees));
  const broken = await reevaluate(records, { name: 'broken', async decide() { throw new Error('offline'); } });
  assert.ok(broken.every(r => r.replayed === null && r.code === 'decision-unavailable' && !r.agrees));
  assert.equal(platform.submissions, 3); // replay never dispatched anything

  const dir = mkdtempSync(join(tmpdir(), 'cognitive-hub-replay-'));
  writeFileSync(join(dir, 'decisions.json'), JSON.stringify(decisions.entries()));
  writeFileSync(join(dir, 'journal.json'), JSON.stringify(runtime.hub.journal.entries()));
  writeFileSync(join(dir, 'runs.json'), JSON.stringify({ runs: runtime.runs.entries(), events: runtime.runs.events() }));
  const output = execFileSync(process.execPath, ['scripts/replay.mjs', dir, '--run', run.id], { encoding: 'utf8' });
  assert.match(output, /run\.started/); assert.equal((output.match(/ decision /g) ?? []).length, 3); assert.match(output, /8 entries/);
  assert.equal(platform.submissions, 3);
});
