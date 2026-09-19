import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('robot-platform example runs without credentials or network', () => {
  const output = execFileSync(process.execPath, ['examples/robot-platform.mjs'], { encoding: 'utf8' });
  assert.match(output, /Default: dry-run/); assert.match(output, /Submitted: pending/);
  assert.match(output, /Verified: verified/); assert.match(output, /Retry unchanged: true/);
});
test('the same core runs a digital-workspace plugin without robot code', () => {
  const output = execFileSync(process.execPath, ['examples/digital-workspace.mjs'], { encoding: 'utf8' });
  assert.match(output, /Digital workspace: verified/);
});
