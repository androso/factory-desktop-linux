import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hashTreeWithModes } from '../scripts/lib.mjs';
import { normalizePayloadModes } from '../scripts/portable-payload.mjs';

test('package payload permissions do not inherit a restrictive build umask', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory payload modes '));
  try {
    const modulePath = new URL('../scripts/portable-payload.mjs', import.meta.url).href;
    for (const mask of [0o022, 0o077]) {
      const payload = path.join(root, String(mask));
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { mkdir, writeFile } from 'node:fs/promises';
import { normalizePayloadModes } from ${JSON.stringify(modulePath)};
process.umask(${mask});
await mkdir(${JSON.stringify(path.join(payload, 'resources'))}, { recursive: true, mode: 0o755 });
await writeFile(${JSON.stringify(path.join(payload, 'libffmpeg.so'))}, 'shared library', { mode: 0o755 });
await writeFile(${JSON.stringify(path.join(payload, 'factory-desktop'))}, 'executable', { mode: 0o755 });
await writeFile(${JSON.stringify(path.join(payload, 'resources/app.asar'))}, 'application', { mode: 0o644 });
await writeFile(${JSON.stringify(path.join(payload, 'build-manifest.json'))}, '{}', { mode: 0o644 });
await normalizePayloadModes(${JSON.stringify(payload)});
`], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      for (const relative of ['', 'resources', 'libffmpeg.so', 'factory-desktop']) {
        assert.equal((await stat(path.join(payload, relative))).mode & 0o7777, 0o755, relative);
      }
      for (const relative of ['resources/app.asar', 'build-manifest.json']) {
        assert.equal((await stat(path.join(payload, relative))).mode & 0o7777, 0o644, relative);
      }
      assert.equal(await readFile(path.join(payload, 'libffmpeg.so'), 'utf8'), 'shared library');
      const fingerprint = await hashTreeWithModes(payload);
      await normalizePayloadModes(payload);
      assert.equal(await hashTreeWithModes(payload), fingerprint);
    }
    assert.equal(await hashTreeWithModes(path.join(root, String(0o022))),
      await hashTreeWithModes(path.join(root, String(0o077))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package payload normalization preserves executable intent and removes group write access', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory payload permissions '));
  try {
    await writeFile(path.join(root, 'data'), 'data');
    await writeFile(path.join(root, 'launch.sh'), '#!/bin/sh\n');
    await chmod(path.join(root, 'data'), 0o660);
    await chmod(path.join(root, 'launch.sh'), 0o770);
    await normalizePayloadModes(root);
    assert.equal((await stat(path.join(root, 'data'))).mode & 0o7777, 0o644);
    assert.equal((await stat(path.join(root, 'launch.sh'))).mode & 0o7777, 0o755);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package payload normalization refuses unexpected privileged files and directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory privileged payload '));
  try {
    const executable = path.join(root, 'unexpected-helper');
    await writeFile(executable, 'executable');
    await chmod(executable, 0o4755);
    await assert.rejects(normalizePayloadModes(root), /file has an unsafe type or mode/);
    await chmod(executable, 0o755);
    const directory = path.join(root, 'unexpected-directory');
    await mkdir(directory);
    await chmod(directory, 0o2755);
    await assert.rejects(normalizePayloadModes(root), /directory has an unsafe type or mode/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
