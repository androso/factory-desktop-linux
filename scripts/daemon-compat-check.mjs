import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ROOT,
  TARGET_FACTORY_VERSION,
  fail,
  sha256File,
} from './lib.mjs';
import { inspectPinnedDroid } from './droid.mjs';

const droid = await inspectPinnedDroid();
const droidPath = await realpath(droid.path);
const droidHash = droid.sha256;
const lockHash = await sha256File(path.join(ROOT, 'package-lock.json'));
await mkdir(path.join(ROOT, 'build', 'gates'), { recursive: true, mode: 0o700 });
const gatePath = path.join(
  ROOT,
  'build',
  'gates',
  `daemon-compatibility-${droidHash}-${lockHash.slice(0, 12)}.json`,
);

const portServer = createServer();
await new Promise((resolve, reject) => {
  portServer.once('error', reject);
  portServer.listen(0, '127.0.0.1', resolve);
});
const { port } = portServer.address();
await new Promise((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));

const testRoot = path.join(ROOT, 'build', `daemon-check-${Date.now()}-${randomUUID()}`);
const home = path.join(testRoot, 'home');
const factoryHome = path.join(testRoot, 'factory-home');
for (const directory of [
  testRoot,
  home,
  factoryHome,
  path.join(testRoot, 'data'),
  path.join(testRoot, 'config'),
  path.join(testRoot, 'cache'),
  path.join(testRoot, 'state'),
  path.join(testRoot, 'tmp'),
]) {
  await mkdir(directory, { recursive: false, mode: 0o700 });
}

const args = [
  'daemon',
  '--droid-path',
  droidPath,
  '--host',
  '127.0.0.1',
  '--port',
  String(port),
  '--liveness-fd',
  '3',
];
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (
    /^(?:FACTORY_|DROID_)/.test(key) ||
    /^(?:http|https|all)_proxy$/i.test(key) ||
    key === 'NODE_OPTIONS'
  ) delete env[key];
}
Object.assign(env, {
  HOME: home,
  XDG_DATA_HOME: path.join(testRoot, 'data'),
  XDG_CONFIG_HOME: path.join(testRoot, 'config'),
  XDG_CACHE_HOME: path.join(testRoot, 'cache'),
  XDG_STATE_HOME: path.join(testRoot, 'state'),
  TMPDIR: path.join(testRoot, 'tmp'),
  FACTORY_HOME_OVERRIDE: factoryHome,
  FACTORY_ENV: 'production',
  FACTORY_RELEASE_CHANNEL: 'production',
  NO_COLOR: '1',
});

const child = spawn(droidPath, args, {
  cwd: home,
  env,
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });

function waitForExit(timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for daemon shutdown.')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function listenerAddresses() {
  const portHex = port.toString(16).toUpperCase().padStart(4, '0');
  const found = [];
  for (const line of readFileSyncProc('/proc/net/tcp')) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] === '0A' && fields[1]?.endsWith(`:${portHex}`)) found.push(fields[1].split(':')[0]);
  }
  return found;
}

function readFileSyncProc(filename) {
  try {
    return readFileSync(filename, 'utf8').split(/\r?\n/).slice(1);
  } catch {
    return [];
  }
}

async function waitForListener() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(`Daemon exited before listening: ${`${stdout}${stderr}`.slice(-1600)}`);
    }
    const addresses = listenerAddresses();
    if (addresses.length) return addresses;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(`Daemon did not listen on 127.0.0.1:${port}: ${`${stdout}${stderr}`.slice(-1600)}`);
}

async function checkWebSocketHandshake() {
  const websocket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket upgrade handshake timed out.')), 10_000);
    websocket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    websocket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket upgrade handshake failed.'));
    }, { once: true });
  });
  const close = new Promise((resolve) => websocket.addEventListener('close', resolve, { once: true }));
  websocket.close(1000, 'compatibility smoke check');
  await Promise.race([close, new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

let listener;
try {
  listener = await waitForListener();
  if (listener.length !== 1 || listener[0] !== '0100007F') {
    fail(`Daemon did not bind only to IPv4 loopback; observed addresses: ${listener.join(', ') || 'none'}.`);
  }
  await checkWebSocketHandshake();
  if (child.stdio[3]?.writable !== true) fail('Could not access the daemon liveness pipe.');
  child.stdio[3].end();
  const exit = await waitForExit(10_000);
  if (exit.code !== 0 || exit.signal !== null) {
    fail(`Daemon liveness shutdown was not clean (code=${exit.code}, signal=${exit.signal}).`);
  }
} catch (error) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await waitForExit(5_000).catch(() => child.kill('SIGKILL'));
  }
  throw error;
}

const resultPath = path.join(testRoot, 'daemon-compatibility.json');
const result = {
  checkedAt: new Date().toISOString(),
  factoryVersion: TARGET_FACTORY_VERSION,
  droidVersion: droid.version,
  droidPath,
  droidSha256: droidHash,
  droidPackageName: droid.packageName,
  droidPackageIntegrity: droid.packageIntegrity,
  packageLockSha256: lockHash,
  startupArguments: args,
  transport: 'WebSocket upgrade handshake, no RPC/auth/model request sent',
  requestedHost: '127.0.0.1',
  observedListenerAddresses: listener,
  livenessPipe: 'closing inherited descriptor caused clean daemon exit',
  shutdown: 'exit 0',
  isolatedHome: path.relative(ROOT, home),
  status: 'pass',
};
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
await writeFile(gatePath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 }).catch(async (error) => {
  if (error.code !== 'EEXIST') throw error;
  const existing = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(gatePath, 'utf8')));
  if (
    existing.status !== 'pass' ||
    existing.droidSha256 !== droidHash ||
    existing.droidVersion !== droid.version ||
    existing.droidPackageIntegrity !== droid.packageIntegrity ||
    existing.packageLockSha256 !== lockHash ||
    existing.transport !== result.transport
  ) {
    fail(`Refusing to overwrite inconsistent daemon compatibility evidence: ${gatePath}`);
  }
});
console.log(`Droid ${droid.version} started with the desktop WebSocket/liveness arguments and exited cleanly.`);
console.log(`Observed loopback-only binding and completed a WebSocket upgrade without auth or RPC calls.`);
console.log(`Evidence: ${path.relative(ROOT, resultPath)} (${droidHash.slice(0, 16)}).`);
