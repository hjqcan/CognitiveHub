// Explicit, offline source seam. Neither inherited credentials nor dotenv/config are loaded.
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const expected = 'd4b78f3cea3a61a5a0d8bb121a69034ae4fa6ac6';
const [checkout, bun] = process.argv.slice(2);
if (!checkout || !bun || !isAbsolute(checkout) || !isAbsolute(bun)) {
  console.error('Usage: node scripts/verify-goodmemory-current-state.mjs /absolute/GoodMemory /absolute/bun');
  process.exit(2);
}
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const env = { PATH: [dirname(bun), dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = args => spawnSync('/usr/bin/git', ['-C', checkout, ...args], { env, encoding: 'utf8' });
const head = git(['rev-parse', 'HEAD']);
const clean = git(['diff', '--quiet', 'HEAD', '--', 'src']);
const entry = join(checkout, 'src/index.ts');
if (head.status !== 0 || head.stdout.trim() !== expected || clean.status !== 0 || !existsSync(entry)) {
  console.error('Expected pristine GoodMemory source at the pinned research revision.');
  process.exit(2);
}
const result = spawnSync(bun, ['test', '--no-env-file', '--no-install', '--config=/dev/null',
  'tests/research/current-state-recall.test.mjs', 'tests/research/current-state-hardening.test.mjs'], {
  cwd: root, env: { ...env, GOODMEMORY_RESEARCH_ENTRY: entry }, stdio: 'inherit', timeout: 30000,
});
process.exit(result.status ?? 1);
