import path from 'node:path';
import { fail } from './lib.mjs';
import { validateArchivePath } from './archive.mjs';

export function assertSha256(actual, expected, description) {
  if (!/^[a-f0-9]{64}$/i.test(expected ?? '') || actual !== expected.toLowerCase()) {
    fail(`${description} SHA-256 mismatch: expected ${expected ?? '<invalid>'}, got ${actual ?? '<missing>'}.`);
  }
  return true;
}

export function validateAsarEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) fail('Application archive contains no entries.');
  const normalized = entries.map((entry) => validateArchivePath(entry.replace(/^\/+/, '')));
  const seen = new Set();
  for (const entry of normalized) {
    const folded = entry.toLocaleLowerCase('en-US');
    if (seen.has(folded)) fail(`Application archive contains duplicate or case-colliding entries: ${entry}`);
    seen.add(folded);
  }
  return normalized;
}

export function assertNoConflictingArchiveHashes(candidates) {
  if (!candidates.length) fail('No application archives found.');
  const hashes = candidates.map((candidate) => candidate.sha256);
  if (hashes.some((hash) => !/^[a-f0-9]{64}$/i.test(hash ?? ''))) {
    fail('An application archive is missing its SHA-256 evidence.');
  }
  if (new Set(hashes).size > 1) {
    fail(`Found conflicting application archives: ${candidates.map((candidate) => candidate.name).join(', ')}`);
  }
  return candidates[0].sha256;
}

export function validateNativePackaging({ archiveEntries, unpackedNativeFiles, manifestNativeFiles }) {
  const nativeEntries = archiveEntries.filter((entry) => entry.endsWith('.node'));
  const unexpected = nativeEntries.filter((entry) => !entry.startsWith('node_modules/keytar/'));
  if (unexpected.length) fail(`Unexpected native module(s) remain in app.asar: ${unexpected.join(', ')}.`);
  const windows = archiveEntries.filter((entry) => /\.(?:dll|exe)$/i.test(entry));
  if (windows.length) fail(`Windows binary entries remain in app.asar: ${windows.join(', ')}.`);
  if (nativeEntries.length !== 1 || unpackedNativeFiles.length !== 1) {
    fail(`Expected one keytar .node entry and one unpacked module; found ${nativeEntries.length} and ${unpackedNativeFiles.length}.`);
  }
  const relative = path.posix.normalize(unpackedNativeFiles[0]);
  if (!relative.startsWith('node_modules/keytar/')) {
    fail(`Unpacked native module has an unexpected location: ${relative}.`);
  }
  const matched = manifestNativeFiles.find((item) => item.path === relative);
  if (!matched || !/^[a-f0-9]{64}$/i.test(matched.sha256)) {
    fail(`Unpacked keytar module is missing a recorded native-build hash: ${relative}.`);
  }
  return matched;
}
