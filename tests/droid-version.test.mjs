import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  DROID_CLI_PACKAGE_NAME,
  TARGET_DROID_CLI_VERSION,
  TARGET_FACTORY_VERSION,
  TOOLCHAIN_ROOT,
} from '../scripts/lib.mjs';

test('desktop and CLI are independently pinned to exact official versions', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const versions = JSON.parse(await readFile(new URL('../versions.json', import.meta.url), 'utf8'));
  const entry = lock.packages[`node_modules/${DROID_CLI_PACKAGE_NAME}`];
  assert.equal(TARGET_FACTORY_VERSION, versions.factory);
  assert.match(versions.updaterNode, /^\d+\.\d+\.\d+$/);
  assert.match(versions.updaterNpm, /^\d+\.\d+\.\d+$/);
  assert.equal(TARGET_FACTORY_VERSION, '0.194.0');
  assert.equal(TARGET_DROID_CLI_VERSION, '0.240.1');
  assert.equal(packageJson.devDependencies[DROID_CLI_PACKAGE_NAME], TARGET_DROID_CLI_VERSION);
  assert.equal(lock.packages[''].devDependencies[DROID_CLI_PACKAGE_NAME], TARGET_DROID_CLI_VERSION);
  assert.equal(entry.version, TARGET_DROID_CLI_VERSION);
  assert.equal(
    entry.resolved,
    `https://registry.npmjs.org/${DROID_CLI_PACKAGE_NAME}/-/cli-linux-x64-${TARGET_DROID_CLI_VERSION}.tgz`,
  );
  assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
});

test('toolchain cache identity includes the manifest as well as the lockfile', async () => {
  const manifest = await readFile(new URL('../package.json', import.meta.url));
  const lock = await readFile(new URL('../package-lock.json', import.meta.url));
  const digest = createHash('sha256').update(manifest).update('\0').update(lock).digest('hex').slice(0, 12);
  assert.ok(TOOLCHAIN_ROOT.endsWith(`toolchain-${TARGET_DROID_CLI_VERSION}-${digest}`));
  assert.notEqual(
    digest,
    createHash('sha256').update(lock).digest('hex').slice(0, 12),
  );
});
