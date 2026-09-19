import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('an operation left open by a crashed process is settled by a fresh process without resubmission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cognitive-hub-restart-'));
  const run = phase => execFileSync(process.execPath, ['examples/restart-recovery.mjs', dir, phase], { encoding: 'utf8' });
  const read = name => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  assert.match(run('submit'), /Submitted: pending/);
  const open = read('journal.json');
  assert.equal(open.length, 1); assert.equal(open[0].status, 'pending'); assert.equal(read('host-tasks.json').submissions, 1);
  const output = run('recover');
  assert.match(output, /Recovered: verified/); assert.match(output, /Submissions: 1/);
  assert.equal(read('journal.json')[0].status, 'verified'); assert.equal(read('host-tasks.json').submissions, 1);
});
