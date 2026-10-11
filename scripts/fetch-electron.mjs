import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ROOT,
  TARGET_ELECTRON_VERSION,
  TOOLCHAIN_ROOT,
  assertElfX64,
  exists,
  fail,
  moveNoReplace,
  readJson,
  requireSuccess,
  run,
  sha256File,
  toolRequire,
  walkFiles,
} from './lib.mjs';
import { extractArchiveSafely } from './archive.mjs';

const require = toolRequire(import.meta.url);
const { downloadArtifact } = require('@electron/get');
async function main() {
  const electronCacheRoot = path.join(ROOT, 'build', 'electron-cache');
  await mkdir(electronCacheRoot, { recursive: true, mode: 0o700 });
  const electronDirectory = path.join(TOOLCHAIN_ROOT, 'node_modules', 'electron');
  const electronPackage = await readJson(path.join(electronDirectory, 'package.json'), 'pinned Electron package');
  if (electronPackage.version !== TARGET_ELECTRON_VERSION) {
    fail(`Expected Electron ${TARGET_ELECTRON_VERSION}, found ${electronPackage.version}.`);
  }

  const filename = `electron-v${TARGET_ELECTRON_VERSION}-linux-x64.zip`;
  const checksums = await readJson(path.join(electronDirectory, 'checksums.json'), 'Electron published checksums');
  const expected = checksums[filename];
  if (!/^[a-f0-9]{64}$/i.test(expected ?? '')) {
    fail(`Pinned Electron release metadata has no SHA-256 for ${filename}.`);
  }

  const archivePath = await downloadArtifact({
    version: TARGET_ELECTRON_VERSION,
    artifactName: 'electron',
    checksums,
    platform: 'linux',
    arch: 'x64',
    cacheRoot: electronCacheRoot,
  });
  const actual = await sha256File(archivePath);
  if (actual !== expected) {
    fail(`Electron ZIP SHA-256 mismatch: expected ${expected}, got ${actual}.`);
  }

  const runtimeDirectory = path.join(ROOT, 'build', 'electron-runtime');
  const runtimeManifestPath = path.join(runtimeDirectory, 'runtime-manifest.json');
  if (await exists(runtimeDirectory)) {
    const existingManifest = await readJson(runtimeManifestPath, 'existing Electron runtime manifest');
    if (
      existingManifest.version !== TARGET_ELECTRON_VERSION ||
      existingManifest.archiveSha256 !== expected
    ) {
      fail(`Refusing to replace existing Electron runtime output: ${runtimeDirectory}.`);
    }
    const existingExecutable = path.join(runtimeDirectory, 'electron');
    await assertElfX64(existingExecutable, 'Existing Electron runtime');
    if (await sha256File(existingExecutable) !== existingManifest.executableSha256) {
      fail('Existing Electron runtime executable does not match its recorded hash.');
    }
    const sandbox = path.join(runtimeDirectory, 'chrome-sandbox');
    const sandboxMode = (await import('node:fs/promises').then(({ stat }) => stat(sandbox))).mode & 0o7777;
    if (
      existingManifest.sandboxMode !== 'user-namespace; chrome-sandbox mode 0755' ||
      sandboxMode !== 0o755
    ) {
      fail('Existing Electron runtime has not been prepared for user-namespace sandboxing without setuid permissions.');
    }
    console.log(`Electron ${TARGET_ELECTRON_VERSION} runtime already exists with a verified matching manifest.`);
    console.log(`${filename} SHA-256: ${actual}`);
    return;
  }

  const stagingDirectory = path.join(ROOT, 'build', `.electron-runtime-${Date.now()}-${randomUUID()}`);
  await extractArchiveSafely(archivePath, stagingDirectory);
  const executable = path.join(stagingDirectory, 'electron');
  await assertElfX64(executable, 'Downloaded Electron executable');
  // Probe the version in ELECTRON_RUN_AS_NODE mode, matching verify.mjs. This
  // avoids requiring a display or a usable Chromium sandbox on the build host.
  const versionResult = run(executable, ['-p', 'process.versions.electron'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  requireSuccess(versionResult, 'Downloaded Electron version check');
  if (versionResult.stdout.trim() !== TARGET_ELECTRON_VERSION) {
    fail(`Downloaded runtime reports Electron ${versionResult.stdout.trim() || '<unknown>'}, expected ${TARGET_ELECTRON_VERSION}.`);
  }
  await chmod(executable, 0o755);
  const chromeSandbox = path.join(stagingDirectory, 'chrome-sandbox');
  await chmod(chromeSandbox, 0o755);
  const runtimeFiles = await walkFiles(stagingDirectory);
  const requiredFiles = ['electron', 'chrome-sandbox', 'chrome_crashpad_handler', 'resources.pak', 'icudtl.dat'];
  for (const required of requiredFiles) {
    if (!runtimeFiles.some((file) => path.relative(stagingDirectory, file) === required)) {
      fail(`Checksum-verified Electron release archive is incomplete; missing ${required}.`);
    }
  }
  const runtimeManifest = {
    version: TARGET_ELECTRON_VERSION,
    platform: 'linux',
    architecture: 'x64',
    archive: filename,
    archiveSha256: actual,
    publishedSha256: expected,
    executableSha256: await sha256File(executable),
    downloadedAt: new Date().toISOString(),
    runtimeFileCount: runtimeFiles.length,
    sandboxMode: 'user-namespace; chrome-sandbox mode 0755',
    source: 'Official Electron release ZIP, checksum matched to the pinned Electron package checksums.json',
  };
  await writeFile(path.join(stagingDirectory, 'runtime-manifest.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  moveNoReplace(stagingDirectory, runtimeDirectory);
  console.log(`Installed Electron ${TARGET_ELECTRON_VERSION} Linux x64.`);
  console.log(`${filename} SHA-256: ${actual}`);
  console.log(`Executable SHA-256: ${runtimeManifest.executableSha256}`);
}

main().catch((error) => {
  console.error(`fetch-electron: ${error.message}`);
  process.exitCode = 1;
});
