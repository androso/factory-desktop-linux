import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { access, chmod, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import versions from '../versions.json' with { type: 'json' };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TARGET_FACTORY_VERSION = versions.factory;
export const TARGET_ELECTRON_VERSION = versions.electron;
export const TARGET_DROID_CLI_VERSION = versions.droidCli;
export const DROID_CLI_PACKAGE_NAME = '@factory/cli-linux-x64';
export const TOOLCHAIN_ROOT = path.join(
  ROOT,
  'build',
  `toolchain-${TARGET_DROID_CLI_VERSION}-${createHash('sha256')
    .update(readFileSync(path.join(ROOT, 'package.json')))
    .update('\0')
    .update(readFileSync(path.join(ROOT, 'package-lock.json')))
    .digest('hex')
    .slice(0, 12)}`,
);

export function toolRequire(moduleUrl) {
  const installedToolchain = path.join(TOOLCHAIN_ROOT, 'package.json');
  return createRequire(existsSync(installedToolchain) ? installedToolchain : moduleUrl);
}

export function fail(message) {
  throw new Error(message);
}

export async function fetchApprovedHttps(
  rawUrl,
  {
    fetchImpl = globalThis.fetch,
    allowedOrigins,
    timeoutMs,
    cache,
    maxRedirects = 5,
    label = 'request',
  } = {},
) {
  const origins = new Set(allowedOrigins ?? []);
  const validate = (candidate) => {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password || !origins.has(url.origin)) {
      fail(`Refusing a non-HTTPS, credentialed, or unapproved URL for ${label}: ${url.origin}.`);
    }
    return url;
  };

  let current = validate(rawUrl);
  const redirects = [];
  for (let count = 0; ; count += 1) {
    const options = {
      redirect: 'manual',
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      ...(cache ? { cache } : {}),
    };
    const response = await fetchImpl(current, options);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, current, redirects };
    }
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) fail(`Redirect from ${current.origin} omitted Location for ${label}.`);
    if (count >= maxRedirects) fail(`HTTPS ${label} exceeded the redirect limit.`);
    const next = validate(new URL(location, current));
    redirects.push({
      status: response.status,
      from: current.origin,
      to: next.origin,
    });
    current = next;
  }
}

export function distributionDirectory(
  name = process.env.FACTORY_DIST_NAME ?? 'factory-desktop-linux',
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    fail('FACTORY_DIST_NAME must be a simple directory name without path separators.');
  }
  return path.join(ROOT, 'dist', name);
}

export async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function requireNewDirectory(target) {
  if (await exists(target)) {
    fail(`Refusing to overwrite existing path: ${target}`);
  }
  await mkdir(target, { recursive: true });
}

export async function walkFiles(directory) {
  const results = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return results;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...await walkFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

export async function walkDirectories(directory) {
  const results = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return results;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`Tree contains a symbolic link: ${fullPath}`);
    if (entry.isDirectory()) {
      results.push(fullPath);
      results.push(...await walkDirectories(fullPath));
    } else if (!entry.isFile()) {
      fail(`Tree contains a special file: ${fullPath}`);
    }
  }
  return results;
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export async function hashFilesInTree(directory, prefix = '') {
  const files = {};
  for (const file of await walkFiles(directory)) {
    const relativePath = path.relative(directory, file);
    if (relativePath.split(path.sep).includes('__pycache__') && relativePath.endsWith('.pyc')) continue;
    files[`${prefix}${relativePath}`] = await sha256File(file);
  }
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

// Root-owned package payloads must stay readable by the normal user who runs
// the app and `rpm -V`, even when the working tree was written with umask 077.
export function publicMode(mode, { directory = false } = {}) {
  return directory || (mode & 0o100) ? 0o755 : 0o644;
}

export async function normalizePublicModes(target) {
  const details = await lstat(target);
  if (details.isSymbolicLink()) fail(`Cannot normalize a symbolic link: ${target}`);
  const mode = details.mode & 0o7777;
  const expected = publicMode(mode, { directory: details.isDirectory() });
  if (mode !== expected) await chmod(target, expected);
  if (!details.isDirectory()) return;
  const entries = await readdir(target);
  entries.sort((a, b) => a.localeCompare(b));
  for (const entry of entries) await normalizePublicModes(path.join(target, entry));
}

export async function hashTreeWithModes(directory, { expectPublicModes = false } = {}) {
  const records = [];

  async function visit(target, relativePath) {
    const details = await lstat(target);
    if (details.isSymbolicLink()) {
      fail(`Cannot fingerprint a tree containing a symbolic link: ${relativePath || '.'}.`);
    }
    const actualMode = details.mode & 0o7777;
    const mode = expectPublicModes
      ? publicMode(actualMode, { directory: details.isDirectory() })
      : actualMode;
    const portablePath = relativePath.split(path.sep).join('/') || '.';
    if (details.isDirectory()) {
      records.push({ path: portablePath, type: 'directory', mode });
      const entries = await readdir(target, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        await visit(path.join(target, entry.name), path.join(relativePath, entry.name));
      }
      return;
    }
    if (!details.isFile()) {
      fail(`Cannot fingerprint a tree containing a special file: ${relativePath}.`);
    }
    records.push({
      path: portablePath,
      type: 'file',
      mode,
      size: details.size,
      sha256: await sha256File(target),
    });
  }

  await visit(directory, '');
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    combined: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

export function requireSuccess(result, label) {
  if (result.status !== 0) {
    fail(`${label} failed (exit ${result.status}):\n${result.combined}`);
  }
}

export async function findExecutable(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return null;
}

export async function readJson(filePath, description = filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    fail(`Cannot read ${description}: ${error.message}`);
  }
}

export async function assertElfX64(filePath, description = filePath) {
  const handle = await import('node:fs/promises').then(({ open }) => open(filePath, 'r'));
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const isElf64LittleEndianX64 =
      bytesRead >= 20 &&
      header[0] === 0x7f && header.toString('ascii', 1, 4) === 'ELF' &&
      header[4] === 2 && header[5] === 1 &&
      header.readUInt16LE(18) === 62;
    if (!isElf64LittleEndianX64) {
      fail(`${description} is not a Linux x86_64 ELF binary: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
}

export async function readOsRelease(filePath = '/etc/os-release') {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return {};
  }
  return Object.fromEntries(content.split(/\r?\n/)
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => {
      const separator = line.indexOf('=');
      const key = line.slice(0, separator);
      let value = line.slice(separator + 1);
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      return [key, value];
    }));
}

export function semverFromOutput(text) {
  return text.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

export function moveNoReplace(source, destination) {
  const script = [
    'import ctypes, os, sys',
    'libc = ctypes.CDLL(None, use_errno=True)',
    'fn = libc.renameat2',
    'fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]',
    'fn.restype = ctypes.c_int',
    'at_fdcwd = -100',
    'rename_noreplace = 1',
    'result = fn(at_fdcwd, os.fsencode(sys.argv[1]), at_fdcwd, os.fsencode(sys.argv[2]), rename_noreplace)',
    'if result != 0:',
    '    error = ctypes.get_errno()',
    '    raise OSError(error, os.strerror(error), sys.argv[2])',
  ].join('\n');
  const result = run('python3', ['-c', script, source, destination]);
  requireSuccess(result, `No-replace publication from ${source} to ${destination}`);
}

export function publishedRelativePath(root, stagingRoot, extractionRoot, destination) {
  return path.relative(
    root,
    path.join(extractionRoot, path.relative(stagingRoot, destination)),
  );
}
