import { chmod, cp, copyFile, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import versions from '../versions.json' with { type: 'json' };
import {
  ROOT,
  TARGET_FACTORY_VERSION,
  exists,
  fail,
  publishedRelativePath,
  readJson,
  sha256File,
  toolRequire,
  walkFiles,
} from './lib.mjs';
import { extractArchiveSafely, validateArchivePath } from './archive.mjs';
import { assertNoConflictingArchiveHashes, validateAsarEntries } from './artifact-validation.mjs';

const require = toolRequire(import.meta.url);
const asar = require('@electron/asar');

function getInspectionPath() {
  const argIndex = process.argv.indexOf('--inspection');
  if (argIndex >= 0) {
    const value = process.argv[argIndex + 1];
    if (!value || value.startsWith('--')) fail('--inspection requires a directory path');
    return path.resolve(ROOT, value);
  }
  return path.join(ROOT, 'inspection');
}

function assertInside(root, candidate, description) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${description} is not strictly within its expected parent: ${candidate}`);
  }
}

async function expandNestedPackages(rawRoot) {
  const records = [];
  let packages = (await walkFiles(rawRoot)).filter((file) => path.extname(file).toLowerCase() === '.nupkg');
  let generation = 0;
  while (packages.length) {
    if (++generation > 4) fail('Nested archive expansion exceeded four levels.');
    const next = [];
    for (const [index, archive] of packages.entries()) {
      const sourceHash = await sha256File(archive);
      const destination = path.join(
        path.dirname(archive),
        `nested-nupkg-${String(generation).padStart(2, '0')}-${String(index + 1).padStart(3, '0')}`,
      );
      await extractArchiveSafely(archive, destination);
      records.push({
        source: path.relative(rawRoot, archive),
        size: (await stat(archive)).size,
        sha256: sourceHash,
        extractedTo: path.relative(rawRoot, destination),
      });
      next.push(...(await walkFiles(destination)).filter((file) =>
        path.extname(file).toLowerCase() === '.nupkg'));
    }
    packages = next;
  }
  return records;
}

async function main() {
  const inspection = getInspectionPath();
  const installerPath = path.join(inspection, versions.installer.filename);
  if (!(await exists(installerPath))) {
    fail(`Required pinned installer is missing: ${path.relative(ROOT, installerPath)}. Run npm run acquire; do not substitute another release.`);
  }
  const topLevelEntries = await readdir(inspection, { withFileTypes: true });
  const unexpectedArchives = topLevelEntries
    .filter((entry) => entry.isFile() && /\.(?:exe|msi|nupkg|zip)$/i.test(entry.name))
    .filter((entry) => entry.name !== versions.installer.filename);
  if (unexpectedArchives.length) {
    fail(`Conflicting top-level archive inputs found: ${unexpectedArchives.map((entry) => entry.name).join(', ')}. Keep only ${versions.installer.filename} in inspection/.`);
  }

  const buildDirectory = path.join(ROOT, 'build');
  await mkdir(buildDirectory, { recursive: true });
  const extractionRoot = path.join(buildDirectory, 'extracted');
  if (await exists(extractionRoot)) {
    fail(`Refusing to overwrite existing extraction output: ${extractionRoot}. Inspect or move it manually before retrying.`);
  }
  const stagingRoot = path.join(buildDirectory, `.extract-${Date.now()}-${randomUUID()}`);
  await mkdir(stagingRoot, { mode: 0o700 });
  const rawRoot = path.join(stagingRoot, 'inputs');
  await mkdir(rawRoot, { mode: 0o700 });
  const extractionDestination = path.join(rawRoot, '01-installer');
  const inputHashBefore = await sha256File(installerPath);
  const extractedEntries = await extractArchiveSafely(installerPath, extractionDestination);
  const inputHashAfter = await sha256File(installerPath);
  if (inputHashBefore !== inputHashAfter) fail('Installer changed during extraction.');
  const inputRecord = {
    name: path.relative(inspection, installerPath),
    size: (await stat(installerPath)).size,
    sha256: inputHashAfter,
    archiveEntryCount: extractedEntries.length,
    extractedTo: publishedRelativePath(ROOT, stagingRoot, extractionRoot, extractionDestination),
  };
  const nestedPackageRecords = await expandNestedPackages(rawRoot);

  const extractedFiles = await walkFiles(rawRoot);
  const asarCandidates = extractedFiles.filter((file) => path.basename(file) === 'app.asar');
  if (asarCandidates.length === 0) {
    fail('No app.asar was found in the extracted installer. The source package is incomplete or uses an unsupported layout.');
  }
  const candidateHashes = await Promise.all(asarCandidates.map(sha256File));
  assertNoConflictingArchiveHashes(asarCandidates.map((file, index) => ({
    name: path.relative(rawRoot, file),
    sha256: candidateHashes[index],
  })));

  let chosenAsar = asarCandidates[0];
  const candidatesWithSidecars = [];
  for (const candidate of asarCandidates) {
    if (await exists(`${candidate}.unpacked`)) candidatesWithSidecars.push(candidate);
  }
  if (candidatesWithSidecars.length > 1) {
    const sidecarHashes = await Promise.all(candidatesWithSidecars.map(async (candidate) =>
      sha256File(path.join(candidate + '.unpacked', 'node_modules', 'keytar', 'package.json')).catch(() => null)));
    if (new Set(sidecarHashes).size > 1) {
      fail('Conflicting app.asar.unpacked sidecars were found.');
    }
  }
  if (candidatesWithSidecars.length) chosenAsar = candidatesWithSidecars[0];

  const appAsarListing = (await asar.listPackage(chosenAsar)).map((entry) => entry.replace(/^\/+/, ''));
  validateAsarEntries(appAsarListing);
  for (const entry of appAsarListing) validateArchivePath(entry);

  const asarContainer = path.dirname(chosenAsar);
  const windowsApplicationRoot = path.basename(asarContainer).toLowerCase() === 'resources'
    ? path.dirname(asarContainer)
    : asarContainer;
  assertInside(rawRoot, windowsApplicationRoot, 'Installer application root');
  const preservedWindowsApplication = path.join(stagingRoot, 'application', 'official-windows-app');
  await mkdir(path.dirname(preservedWindowsApplication), { recursive: true });
  await cp(windowsApplicationRoot, preservedWindowsApplication, { recursive: true, errorOnExist: true, dereference: false });

  const applicationRoot = path.join(stagingRoot, 'application');
  const resourcesRoot = path.join(applicationRoot, 'resources');
  const appAsarPath = path.join(resourcesRoot, 'app.asar');
  const appUnpackedSource = `${chosenAsar}.unpacked`;
  const unpackedDirectoryPresent = await exists(appUnpackedSource);
  await mkdir(resourcesRoot, { recursive: true });
  await copyFile(chosenAsar, appAsarPath, 0);
  if (unpackedDirectoryPresent) {
    const sidecars = await walkFiles(appUnpackedSource);
    if (!sidecars.length) fail('The app.asar.unpacked sidecar exists but is empty.');
    await cp(appUnpackedSource, `${appAsarPath}.unpacked`, { recursive: true, errorOnExist: true, dereference: false });
  }

  const appSource = path.join(applicationRoot, 'app');
  await asar.extractAll(appAsarPath, appSource);
  if (unpackedDirectoryPresent) {
    await cp(`${appAsarPath}.unpacked`, appSource, { recursive: true, force: false, dereference: false });
  }
  const appPackage = await readJson(path.join(appSource, 'package.json'), 'Factory app package manifest');
  if (appPackage.version !== TARGET_FACTORY_VERSION) {
    fail(`Expected Factory Desktop ${TARGET_FACTORY_VERSION}, found ${appPackage.version ?? 'no package version'}.`);
  }
  const requiredSidecarEntries = ['node_modules/keytar/package.json'];
  for (const entry of requiredSidecarEntries) {
    const expected = appAsarListing.includes(entry);
    let presentInAsar = false;
    try {
      presentInAsar = Boolean(asar.extractFile(appAsarPath, entry));
    } catch {
      // Unpacked entries are intentionally absent from the archive body.
    }
    const presentUnpacked = await exists(path.join(`${appAsarPath}.unpacked`, entry));
    if (expected && !presentInAsar && !presentUnpacked) {
      fail(`Application data is incomplete; required path is missing from app.asar and sidecars: ${entry}`);
    }
  }
  const completeFiles = await walkFiles(preservedWindowsApplication);
  if (completeFiles.length < 2) fail('Preserved Windows application data is unexpectedly incomplete.');

  const manifest = {
    factoryVersion: appPackage.version,
    extractedAt: new Date().toISOString(),
    inspectionDirectory: path.relative(ROOT, inspection),
    inputFiles: [inputRecord],
    nestedPackages: nestedPackageRecords,
    appAsar: {
      source: path.relative(rawRoot, chosenAsar),
      sha256: await sha256File(chosenAsar),
      unpackedDirectoryPresent,
      unpackedFileCount: unpackedDirectoryPresent ? (await walkFiles(appUnpackedSource)).length : 0,
      archiveEntryCount: appAsarListing.length,
    },
    appPackageName: appPackage.name ?? null,
    appMain: appPackage.main ?? null,
    appDependencies: appPackage.dependencies ?? {},
    preservedWindowsApplication: publishedRelativePath(
      ROOT,
      stagingRoot,
      extractionRoot,
      preservedWindowsApplication,
    ),
    preservedWindowsFileCount: completeFiles.length,
  };
  await writeFile(path.join(stagingRoot, 'input-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(path.join(stagingRoot, 'EXTRACTION_COMPLETE'), `${TARGET_FACTORY_VERSION}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  await rename(stagingRoot, extractionRoot);
  console.log(`Extracted Factory Desktop ${appPackage.version} to ${path.relative(ROOT, path.join(extractionRoot, 'application'))}.`);
  console.log(`Recorded input SHA-256 ${inputRecord.sha256} and extracted ${completeFiles.length} Windows app files.`);
  console.log('The Windows installer was treated as archive data only and was never executed.');
}

main().catch((error) => {
  console.error(`extract: ${error.message}`);
  process.exitCode = 1;
});
