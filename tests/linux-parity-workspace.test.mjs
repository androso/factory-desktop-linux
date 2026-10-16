import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../scripts/lib.mjs';
import { SOURCE_INPUTS } from '../scripts/native.mjs';

async function sourceWorkspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-parity-workspace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const input of SOURCE_INPUTS) {
    await cp(path.join(ROOT, input), path.join(directory, input), { recursive: true });
  }
  return directory;
}

function runParityTests(directory, args = []) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [
    '--test', '--test-reporter=tap', ...args, 'tests/linux-parity.test.mjs',
  ], { cwd: directory, env, encoding: 'utf8', timeout: 30_000 });
}

test('parity tests pass in a fresh native source workspace before extraction', async (t) => {
  const directory = await sourceWorkspace(t);
  await assert.rejects(lstat(path.join(directory, 'build', 'extracted')), { code: 'ENOENT' });
  const result = runParityTests(directory);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# skipped 2\b/);
  assert.match(result.stdout, /# SKIP requires the extracted official app/);
});

test('parity checks still fail for a present but empty official bundle', async (t) => {
  const directory = await sourceWorkspace(t);
  await mkdir(path.join(directory, 'build', 'extracted', 'application', 'app', '.vite', 'build'), { recursive: true });
  const result = runParityTests(directory, [
    '--test-name-pattern=all parity patches apply exactly',
  ]);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /extracted official bundle contains no JavaScript/);
  assert.doesNotMatch(result.stdout, /# SKIP requires the extracted official app/);
});
