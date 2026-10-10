import { lstat, mkdir, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fail, requireSuccess, run, toolRequire } from './lib.mjs';

const require = toolRequire(import.meta.url);
const sevenZip = require('7zip-bin');
const MAX_ARCHIVE_ENTRIES = 300_000;
const MAX_UNPACKED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;

export function validateArchivePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    fail('Archive contains an empty or invalid path.');
  }
  const normalizedSeparators = rawPath.replaceAll('\\', '/');
  if (
    normalizedSeparators.startsWith('/') ||
    /^[A-Za-z]:/.test(normalizedSeparators) ||
    normalizedSeparators.split('/').some((component) => component === '..')
  ) {
    fail(`Archive path escapes the extraction boundary: ${rawPath}`);
  }
  const normalized = path.posix.normalize(normalizedSeparators);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    fail(`Archive path is not a safe relative path: ${rawPath}`);
  }
  return normalized;
}

export function parse7zListing(listing) {
  const entries = [];
  let record = {};
  let readingEntries = false;
  const flush = () => {
    if (readingEntries && record.Path) entries.push(record);
    record = {};
  };
  for (const line of listing.split(/\r?\n/)) {
    if (line.trim() === '----------') {
      flush();
      readingEntries = true;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const separator = line.indexOf(' = ');
    if (separator < 0) continue;
    record[line.slice(0, separator)] = line.slice(separator + 3);
  }
  flush();
  return entries;
}

export function validateArchiveListing(listing) {
  const entries = parse7zListing(listing);
  if (entries.length === 0) fail('Archive listing is empty or not a supported 7-Zip archive.');
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    fail(`Archive exceeds the entry limit (${MAX_ARCHIVE_ENTRIES}).`);
  }
  let unpackedBytes = 0;
  const names = new Set();
  for (const entry of entries) {
    const safePath = validateArchivePath(entry.Path);
    const key = safePath.toLocaleLowerCase('en-US');
    if (names.has(key)) fail(`Archive contains duplicate or case-colliding paths: ${entry.Path}`);
    names.add(key);
    if (Object.hasOwn(entry, 'Symbolic Link') || Object.hasOwn(entry, 'Hard Link')) {
      fail(`Archive link entries are not allowed: ${entry.Path}`);
    }
    if (/^[LSl]/.test(entry.Attributes ?? '')) {
      fail(`Archive contains a link or special file: ${entry.Path}`);
    }
    const size = Number(entry.Size ?? 0);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) {
      fail(`Archive entry has an invalid or excessive size: ${entry.Path}`);
    }
    unpackedBytes += size;
    if (unpackedBytes > MAX_UNPACKED_BYTES) {
      fail(`Archive exceeds the unpacked size limit (${MAX_UNPACKED_BYTES} bytes).`);
    }
  }
  return entries;
}

async function assertNoLinksWithin(root) {
  const rootRealPath = await realpath(root);
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
        fail(`Extractor produced a link or special file: ${path.relative(root, fullPath)}`);
      }
      const resolved = await realpath(fullPath);
      const relative = path.relative(rootRealPath, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        fail(`Extracted path escapes its staging directory: ${path.relative(root, fullPath)}`);
      }
      if (entry.isDirectory()) pending.push(fullPath);
    }
  }
}

export async function inspectArchive(archivePath) {
  const result = run(sevenZip.path7za, ['l', '-slt', archivePath]);
  requireSuccess(result, `Archive inspection for ${path.basename(archivePath)}`);
  const entries = validateArchiveListing(result.stdout);
  return { entries, listing: result.stdout };
}

export async function extractArchiveSafely(archivePath, destination) {
  const { entries } = await inspectArchive(archivePath);
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const result = run(sevenZip.path7za, ['x', '-y', `-o${destination}`, archivePath]);
  requireSuccess(result, `Archive extraction for ${path.basename(archivePath)}`);
  await assertNoLinksWithin(destination);
  return entries;
}
