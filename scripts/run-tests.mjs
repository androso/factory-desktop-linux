import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, TARGET_ELECTRON_VERSION, TARGET_FACTORY_VERSION, walkFiles } from './lib.mjs';

const testFiles = (await readdir(path.join(ROOT, 'tests')))
  .filter((file) => file.endsWith('.test.mjs'))
  .sort()
  .map((file) => path.join('tests', file));
const files = [
  'package.json',
  'package-lock.json',
  'versions.json',
  ...await walkFiles(path.join(ROOT, 'scripts')),
  ...await walkFiles(path.join(ROOT, 'tests')),
].filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`))
  .map((file) => path.relative(ROOT, file))
  .sort();
const digest = createHash('sha256');
for (const relative of files) {
  digest.update(relative).update('\0').update(await readFile(path.join(ROOT, relative))).update('\0');
}
const sourceSha256 = digest.digest('hex');
const gatePath = path.join(ROOT, 'build', 'gates', `synthetic-tests-${sourceSha256}.json`);
const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
else {
  const gateDirectory = path.join(ROOT, 'build', 'gates');
  await mkdir(gateDirectory, { recursive: true, mode: 0o700 });
  const gate = {
    checkedAt: new Date().toISOString(),
    factoryVersion: TARGET_FACTORY_VERSION,
    electronVersion: TARGET_ELECTRON_VERSION,
    sourceSha256,
    testFiles,
    status: 'pass',
  };
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, { flag: 'wx', mode: 0o600 }).catch(async (error) => {
    if (error.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(gatePath, 'utf8'));
    if (existing.status !== 'pass' || existing.sourceSha256 !== sourceSha256) {
      throw new Error(`Refusing to overwrite inconsistent synthetic test evidence: ${gatePath}`);
    }
  });
}
