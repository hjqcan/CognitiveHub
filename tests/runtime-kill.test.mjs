import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from './runtime-host.mjs';

const runWorker = (dir, killOn) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['tests/runtime-worker.mjs', dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; if (killOn && output.includes(killOn)) child.kill('SIGKILL'); });
  child.on('error', reject);
  child.on('exit', (code, signal) => killOn || code === 0 ? resolve({ output, signal }) : reject(new Error(`worker exited ${code}\n${output}`)));
});

test('a goal survives a worker killed mid-dispatch: the next worker reconciles by key and never resubmits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cognitive-hub-kill-'));
  const read = name => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  const write = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value));
  const complete = () => {
    const platform = read('platform.json');
    for (const task of Object.values(platform.tasks)) if (task.status === 'running') { task.status = 'done'; platform.stage = Math.max(platform.stage, task.to); }
    write('platform.json', platform);
  };
  write('platform.json', { ...createPlatform(), info: 'given' });
  let r = await runWorker(dir); assert.match(r.output, /step: waiting waiting/);            // to-1 dispatched
  complete();
  write('platform.json', { ...read('platform.json'), hang: true });
  r = await runWorker(dir, 'submitted');                                                     // to-2 recorded by the platform, then SIGKILL
  assert.equal(r.signal, 'SIGKILL');
  const open = read('journal.json').find(record => record.status === 'submitted');
  assert.equal(open.receipt, null); assert.equal(read('platform.json').submissions, 2);
  write('platform.json', { ...read('platform.json'), hang: false });
  r = await runWorker(dir); assert.match(r.output, /step: waiting waiting/);                // reconciled by key, still running
  assert.equal(read('platform.json').submissions, 2); assert.equal(read('journal.json').find(x => x.id === open.id).status, 'pending');
  complete();
  r = await runWorker(dir); assert.match(r.output, /step: waiting waiting/);                // to-3 dispatched
  complete();
  r = await runWorker(dir); assert.match(r.output, /step: completed completed/);
  assert.equal(read('platform.json').submissions, 3);
  assert.equal(read('runs.json').runs[0].status, 'completed');
  assert.equal(read('journal.json').filter(x => x.status === 'verified').length, 3);
});
