import {
  chmod, copyFile, cp, mkdir, realpath, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT, assertElfX64, fail, hashTreeWithModes, normalizePublicModes, readJson, sha256File, walkFiles,
} from './lib.mjs';
import { SOURCE_INPUTS } from './native.mjs';

async function resolveNpmPackageDirectory() {
  const candidates = [process.env.FACTORY_UPDATE_NPM_CLI, process.env.npm_execpath].filter(Boolean);
  if (!candidates.length) {
    const result = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 30_000 });
    if (result.status === 0) candidates.push(path.join(result.stdout.trim(), 'npm', 'bin', 'npm-cli.js'));
  }
  for (const candidate of candidates) {
    const cliPath = await realpath(candidate).catch(() => null);
    if (!cliPath || path.basename(cliPath) !== 'npm-cli.js' ||
        path.basename(path.dirname(path.dirname(cliPath))) !== 'npm') continue;
    const directory = path.dirname(path.dirname(cliPath));
    const manifest = await readJson(path.join(directory, 'package.json')).catch(() => null);
    if (manifest?.name === 'npm') return { directory, manifest };
  }
  fail('Could not locate npm to bundle the managed updater runtime.');
}

export async function stageUpdaterRuntime(bundleRoot, {
  repositoryRoot = ROOT,
  executable = process.execPath,
} = {}) {
  const pins = await readJson(path.join(repositoryRoot, 'versions.json'), 'managed updater pins');
  if (pins.updaterNode !== process.version.slice(1)) {
    fail(`Managed package creation requires Node ${pins.updaterNode}, found ${process.version}.`);
  }
  const npm = await resolveNpmPackageDirectory();
  if (npm.manifest.version !== pins.updaterNpm) {
    fail(`Managed package creation requires npm ${pins.updaterNpm}, found ${npm.manifest.version}.`);
  }

  const updaterRoot = path.join(bundleRoot, 'updater');
  const nodePath = path.join(updaterRoot, 'bin', 'node');
  const recipesRoot = path.join(updaterRoot, 'recipes');
  const npmDirectory = path.join(updaterRoot, 'node_modules', 'npm');
  await mkdir(path.dirname(nodePath), { recursive: true, mode: 0o755 });
  await mkdir(recipesRoot, { recursive: true, mode: 0o755 });
  await mkdir(path.dirname(npmDirectory), { recursive: true, mode: 0o755 });
  await copyFile(executable, nodePath);
  await chmod(nodePath, 0o755);
  await assertElfX64(nodePath, 'Managed updater Node runtime');
  const nodeSha256 = await sha256File(nodePath);
  await cp(npm.directory, npmDirectory, { recursive: true, errorOnExist: true });
  const npmTreeSha256 = await hashTreeWithModes(npmDirectory);

  const checksums = [];
  for (const file of await walkFiles(npmDirectory)) {
    checksums.push(`${await sha256File(file)}  ${path.relative(updaterRoot, file).split(path.sep).join('/')}`);
  }
  await writeFile(path.join(updaterRoot, 'npm.sha256'), `${checksums.sort().join('\n')}\n`, {
    flag: 'wx',
    mode: 0o644,
  });
  await writeFile(path.join(updaterRoot, 'runtime-manifest.json'), `${JSON.stringify({
    version: pins.updaterNode,
    npmVersion: pins.updaterNpm,
    platform: 'linux',
    architecture: 'x64',
    executable: 'bin/node',
    sha256: nodeSha256,
    npmTreeSha256,
    source: 'Pinned host Node executable copied into the root-owned package payload.',
  }, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  await writeFile(path.join(updaterRoot, 'runtime.sha256'), `${nodeSha256}  bin/node\n`, {
    flag: 'wx',
    mode: 0o644,
  });

  for (const name of SOURCE_INPUTS) {
    await cp(
      path.join(repositoryRoot, name),
      path.join(recipesRoot, name),
      { recursive: true, errorOnExist: true },
    );
    await normalizePublicModes(path.join(recipesRoot, name));
  }
  return { updaterRoot, nodePath, recipesRoot, npmDirectory, npmTreeSha256 };
}
