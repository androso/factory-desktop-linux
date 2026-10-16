import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT,
  DROID_CLI_PACKAGE_NAME,
  TARGET_DROID_CLI_VERSION,
  TARGET_ELECTRON_VERSION,
  TARGET_FACTORY_VERSION,
  TOOLCHAIN_ROOT,
  assertElfX64,
  exists,
  fail,
  hashFilesInTree,
  moveNoReplace,
  readJson,
  sha256File,
} from './lib.mjs';
import { ensurePinnedDroidExecutable } from './droid.mjs';

const packagePath = path.join(ROOT, 'package.json');
const lockPath = path.join(ROOT, 'package-lock.json');
const packageContents = await readFile(packagePath);
const lockContents = await readFile(lockPath);
const packageJson = JSON.parse(packageContents);
const packageHash = createHash('sha256').update(packageContents).digest('hex');
const lockHash = createHash('sha256').update(lockContents).digest('hex');
const toolchainDirectory = TOOLCHAIN_ROOT;
const toolchainManifestPath = path.join(toolchainDirectory, 'factory-toolchain-manifest.json');
const stageDirectory = path.join(ROOT, 'build', `.toolchain-${Date.now()}-${randomUUID()}`);
const npmCache = path.join(stageDirectory, '.npm-cache');
const gateDirectory = path.join(ROOT, 'build', 'gates');
const gatePath = path.join(gateDirectory, `clean-install-${packageHash.slice(0, 16)}-${lockHash.slice(0, 16)}.json`);

async function inspectInstalledPackages(nodeModules, installation) {
  const installed = {};
  for (const [name, version] of Object.entries(packageJson.devDependencies)) {
    const packageFile = path.join(nodeModules, name, 'package.json');
    const entry = await readJson(packageFile, `installed ${name} package`);
    if (entry.version !== version) {
      fail(`Locked installation contains ${name} ${entry.version}, expected ${version}.`);
    }
    installed[name] = {
      version: entry.version,
      packageJsonSha256: await sha256File(packageFile),
    };
  }
  if (installed.electron?.version !== TARGET_ELECTRON_VERSION) {
    fail(`Clean installation contains Electron ${installed.electron?.version ?? 'unknown'}, expected ${TARGET_ELECTRON_VERSION}.`);
  }
  if (installed[DROID_CLI_PACKAGE_NAME]?.version !== TARGET_DROID_CLI_VERSION) {
    fail(`Clean installation contains ${DROID_CLI_PACKAGE_NAME}@${installed[DROID_CLI_PACKAGE_NAME]?.version ?? 'unknown'}, expected ${TARGET_DROID_CLI_VERSION}.`);
  }
  if (installation.factoryVersion !== TARGET_FACTORY_VERSION) {
    fail(`Installation manifest targets Factory ${installation.factoryVersion}, expected ${TARGET_FACTORY_VERSION}.`);
  }
  return installed;
}

async function ensureArchiveToolExecutable(nodeModules, { fixMode = false } = {}) {
  const packageRoot = path.join(nodeModules, '7zip-bin');
  const require = createRequire(path.join(packageRoot, 'package.json'));
  const sevenZip = require('7zip-bin');
  const executable = await realpath(sevenZip.path7za);
  const realPackageRoot = await realpath(packageRoot);
  const relative = path.relative(realPackageRoot, executable);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('Pinned 7-Zip executable resolves outside the installed 7zip-bin package.');
  }
  const details = await lstat(executable);
  if (!details.isFile()) fail('Pinned 7-Zip executable is not a regular file.');
  await assertElfX64(executable, 'Pinned 7-Zip executable');
  try {
    await access(executable, constants.X_OK);
  } catch {
    if (!fixMode) fail('Pinned 7-Zip executable is not executable; refusing to change the existing toolchain.');
    await chmod(executable, 0o755);
  }
  return { path: path.relative(nodeModules, executable), sha256: await sha256File(executable) };
}

await mkdir(path.join(ROOT, 'build'), { recursive: true, mode: 0o700 });
await mkdir(gateDirectory, { recursive: true, mode: 0o700 });

if (await exists(toolchainDirectory)) {
  const manifest = await readJson(toolchainManifestPath, 'existing locked toolchain manifest');
  if (
    manifest.packageJsonSha256 !== packageHash ||
    manifest.packageLockSha256 !== lockHash ||
    manifest.lifecycleScripts !== 'disabled'
  ) {
    fail(`Existing toolchain does not match the current package lock: ${toolchainDirectory}. It was preserved.`);
  }
  const installed = await inspectInstalledPackages(path.join(toolchainDirectory, 'node_modules'), manifest);
  await ensureArchiveToolExecutable(path.join(toolchainDirectory, 'node_modules'));
  const droid = await ensurePinnedDroidExecutable({
    nodeModules: path.join(toolchainDirectory, 'node_modules'),
  });
  if (
    manifest.droid?.version !== TARGET_DROID_CLI_VERSION ||
    manifest.droid?.sha256 !== droid.sha256 ||
    manifest.droid?.packageIntegrity !== droid.packageIntegrity
  ) {
    fail(`Existing pinned Droid CLI differs from its manifest in ${toolchainDirectory}. It was preserved.`);
  }
  const nodeModulesFilesSha256 = await hashFilesInTree(path.join(toolchainDirectory, 'node_modules'));
  if (!manifest.nodeModulesFilesSha256 || manifest.nodeModulesFilesSha256 !== nodeModulesFilesSha256) {
    fail(`Existing toolchain file hashes do not match its manifest: ${toolchainDirectory}. It was preserved.`);
  }
  const gate = {
    checkedAt: new Date().toISOString(),
    factoryVersion: TARGET_FACTORY_VERSION,
    droidCliVersion: TARGET_DROID_CLI_VERSION,
    electronVersion: TARGET_ELECTRON_VERSION,
    packageJsonSha256: packageHash,
    packageLockSha256: lockHash,
    installed,
    install: 'npm ci --ignore-scripts --no-audit --no-fund',
    lifecycleScripts: 'disabled',
    status: 'pass',
    reusedVerifiedToolchain: true,
  };
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, { flag: 'wx', mode: 0o600 }).catch(async (error) => {
    if (error.code !== 'EEXIST') throw error;
    const previous = await readJson(gatePath, 'existing clean-install gate');
    if (previous.status !== 'pass' || previous.packageJsonSha256 !== packageHash || previous.packageLockSha256 !== lockHash) {
      fail(`Refusing to overwrite inconsistent clean-install evidence: ${gatePath}`);
    }
  });
  console.log('Reused the clean, locked build toolchain with lifecycle scripts disabled.');
  process.exit(0);
}

await mkdir(stageDirectory, { recursive: false, mode: 0o700 });
await writeFile(path.join(stageDirectory, 'package.json'), packageContents, { flag: 'wx', mode: 0o600 });
await writeFile(path.join(stageDirectory, 'package-lock.json'), lockContents, { flag: 'wx', mode: 0o600 });
await writeFile(path.join(stageDirectory, '.npmrc'), 'ignore-scripts=true\n', { flag: 'wx', mode: 0o600 });

const npmCli = process.env.npm_execpath || process.env.FACTORY_UPDATE_NPM_CLI;
const npmArgs = [
  'ci',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--cache',
  npmCache,
];
const result = spawnSync(npmCli ? process.execPath : 'npm', [
  ...(npmCli ? [npmCli] : []),
  ...npmArgs,
], {
  cwd: stageDirectory,
  encoding: 'utf8',
  timeout: 10 * 60 * 1000,
  maxBuffer: 16 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Clean locked installation failed (exit ${result.status}):\n${(result.stdout ?? '') + (result.stderr ?? '')}`);
}

const stageManifest = {
  checkedAt: new Date().toISOString(),
  factoryVersion: TARGET_FACTORY_VERSION,
  droidCliVersion: TARGET_DROID_CLI_VERSION,
  electronVersion: TARGET_ELECTRON_VERSION,
  packageJsonSha256: packageHash,
  packageLockSha256: lockHash,
  lifecycleScripts: 'disabled',
};
const installed = await inspectInstalledPackages(path.join(stageDirectory, 'node_modules'), stageManifest);
stageManifest.sevenZipExecutable = await ensureArchiveToolExecutable(
  path.join(stageDirectory, 'node_modules'),
  { fixMode: true },
);
const droid = await ensurePinnedDroidExecutable({
  nodeModules: path.join(stageDirectory, 'node_modules'),
  fixMode: true,
});
stageManifest.droid = {
  version: droid.version,
  sha256: droid.sha256,
  packageName: droid.packageName,
  packageIntegrity: droid.packageIntegrity,
  packageResolved: droid.packageResolved,
};
stageManifest.installed = installed;
stageManifest.nodeModulesFilesSha256 = await hashFilesInTree(path.join(stageDirectory, 'node_modules'));
await writeFile(path.join(stageDirectory, 'factory-toolchain-manifest.json'), `${JSON.stringify(stageManifest, null, 2)}\n`, {
  flag: 'wx',
  mode: 0o600,
});
moveNoReplace(stageDirectory, toolchainDirectory);

const gate = {
  checkedAt: stageManifest.checkedAt,
  factoryVersion: TARGET_FACTORY_VERSION,
  droidCliVersion: TARGET_DROID_CLI_VERSION,
  electronVersion: TARGET_ELECTRON_VERSION,
  packageJsonSha256: packageHash,
  packageLockSha256: lockHash,
  installed,
  install: 'npm ci --ignore-scripts --no-audit --no-fund',
  lifecycleScripts: 'disabled',
  status: 'pass',
  reusedVerifiedToolchain: false,
};
await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log('Clean locked installation passed with lifecycle scripts disabled.');
console.log(`Verified toolchain retained at ${path.relative(ROOT, toolchainDirectory)}.`);
