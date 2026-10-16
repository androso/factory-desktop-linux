import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  FactoryUpdater, invokeFlocked, updaterStateDirectory,
} from './updater.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const recipesRoot = path.resolve(path.dirname(scriptPath), '..');
const stateDirectory = updaterStateDirectory();
const installLockPath = path.join(stateDirectory, 'install.lock');
const updater = new FactoryUpdater({
  recipesRoot,
  stateDirectory,
  backgroundInstall: async () => {
    const result = invokeFlocked(process.execPath, [scriptPath, '--install-locked'], {
      lockPath: installLockPath,
    });
    if (result.status === 75) return { waiting: true };
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `Update installation exited with status ${result.status}.`);
    }
    return { installed: true };
  },
  backgroundUpdatesEnabled: backgroundTimerEnabled,
  disableBackgroundUpdates: () => runUserSystemctl(['disable', '--now', 'factory-update-manager.timer']),
  enableBackgroundUpdates: () => runUserSystemctl(['enable', '--now', 'factory-update-manager.timer']),
});

function parseBool(value, name) {
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(`${name} must be 0 or 1.`);
}

function runUserSystemctl(args) {
  const result = spawnSync('/usr/bin/systemctl', ['--user', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr?.trim() ||
      `systemctl --user ${args.join(' ')} failed with status ${result.status}.`);
  }
  return result.stdout.trim();
}

function backgroundTimerEnabled() {
  const result = spawnSync('/usr/bin/systemctl', [
    '--user', 'is-enabled', 'factory-update-manager.timer',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });
  if (result.status === 0) return result.stdout.trim() === 'enabled';
  if (result.status === 1 || result.stderr.includes('not found')) return false;
  throw new Error(result.error?.message || result.stderr.trim() || 'Could not inspect updater timer state.');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || !command) {
    console.log([
      'Usage: factory-update-manager status|check|install-ready|rollback|enable|disable|recover',
      '       factory-update-manager setup <legacy-state-path>',
      '       factory-update-manager policy <hosted:0|1> <airgap:0|1> <org-disabled:0|1>',
      'Checks and builds as the current user; only pkexec may install the verified RPM.',
    ].join('\n'));
    return;
  }
  if (command === 'status' && args.length === 0) {
    console.log(JSON.stringify(await updater.publicStatus(), null, 2));
  } else if (command === 'check' &&
      args.every((argument) => argument === '--now' || argument === '--background')) {
    const status = await updater.check({
      force: args.includes('--now'),
      background: args.includes('--background'),
    });
    console.log(JSON.stringify(status, null, 2));
  } else if (command === 'policy' && args.length === 3) {
    const status = await updater.setPolicy({
      hostedServicesEnabled: parseBool(args[0], 'hosted'),
      airgapEnabled: parseBool(args[1], 'airgap'),
      organizationUpdatesDisabled: parseBool(args[2], 'org-disabled'),
    });
    console.log(JSON.stringify(status, null, 2));
  } else if (command === 'prepare-handoff' && args.length === 0) {
    console.log(JSON.stringify(await updater.prepareHandoff()));
  } else if (command === 'cancel-handoff' && args.length === 0) {
    console.log(JSON.stringify({ cancelled: await updater.cancelHandoff() }));
  } else if (command === 'after-app-exit' && args.length === 0) {
    const result = await updater.completeAfterAppExit();
    console.log(JSON.stringify(result));
    if (result.relaunch) process.exitCode = 10;
  } else if (command === 'install-ready' && args.length === 0) {
    console.log(JSON.stringify(await updater.installReady({ restart: false, source: 'manual' })));
  } else if (command === 'rollback' && args.length === 0) {
    console.log(JSON.stringify(await updater.installReady({ rollback: true, restart: false, source: 'rollback' })));
  } else if (command === 'setup' && args.length === 1) {
    console.log(JSON.stringify(await updater.setup(args[0])));
  } else if (command === '--install-locked' && args.length === 0) {
    console.log(JSON.stringify(await updater.installReady({ restart: false, source: 'background' })));
  } else if (command === 'recover' && args.length === 0) {
    console.log(JSON.stringify(await updater.recover()));
  } else if (command === 'enable' && args.length === 0) {
    await updater.saveManagerState({ backgroundChecksDisabled: false });
    runUserSystemctl(['enable', '--now', 'factory-update-manager.timer']);
    console.log('Background update checks enabled for this user.');
  } else if (command === 'disable' && args.length === 0) {
    await updater.saveManagerState({ backgroundChecksDisabled: true });
    runUserSystemctl(['disable', '--now', 'factory-update-manager.timer']);
    console.log('Background update checks disabled. Ready candidates were retained.');
  } else {
    throw new Error('Unknown command or extra arguments. Run factory-update-manager help.');
  }
}

main().catch((error) => {
  console.error(`factory-update-manager: ${error.message}`);
  process.exitCode = 1;
});
