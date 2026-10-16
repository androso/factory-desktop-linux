const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Shell startup files may add tools, but must not change the launcher's profile
// or reintroduce Electron overrides that it deliberately removed.
const launcherKeys = [
  'HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'FACTORY_HOME_OVERRIDE', 'FACTORY_LINUX_PROFILE', 'FACTORY_LINUX_HOST_HOME',
  'FACTORY_LINUX_HOST_CONFIG_HOME', 'FACTORY_UPDATE_STATE_HOME', 'FACTORY_UPDATE_CACHE_HOME',
  'FACTORY_ENV', 'FACTORY_DEPLOYMENT_ENV', 'FACTORY_RELEASE_CHANNEL',
  'FACTORY_DISABLE_KEYRING', 'FACTORY_DESKTOP_RENDERER_URL', 'FACTORY_E2E_DAEMON_HOOKS',
  'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR',
];

function mergeShellEnvironment(parent, shell) {
  const result = { ...shell };
  for (const key of launcherKeys) {
    if (parent[key] === undefined) delete result[key];
    else result[key] = parent[key];
  }
  return result;
}

function fileStat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameFile(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function digest(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Expected a regular CLI file.');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let size;
    while ((size = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function createCliIntegration({ env = process.env } = {}) {
  function hostHome() {
    const home = env.FACTORY_LINUX_HOST_HOME || env.HOME || os.homedir();
    if (!path.isAbsolute(home)) throw new Error('The user home must be an absolute path.');
    return home;
  }

  function installDirectory() {
    return path.join(hostHome(), '.local', 'bin');
  }

  function paths() {
    const directory = installDirectory();
    return {
      directory,
      binary: path.join(directory, 'droid'),
      record: path.join(directory, '.factory-desktop-droid.json'),
    };
  }

  function shellConfigPath() {
    const home = hostHome();
    switch (path.basename(env.SHELL || '')) {
      case 'zsh':
        return path.resolve(home, env.ZDOTDIR || home, '.zshrc');
      case 'bash':
        return path.join(home, '.bashrc');
      case 'fish': {
        const config = env.FACTORY_LINUX_HOST_CONFIG_HOME || env.XDG_CONFIG_HOME || path.join(home, '.config');
        if (!path.isAbsolute(config)) throw new Error('The user config directory must be an absolute path.');
        return path.join(config, 'fish', 'config.fish');
      }
      default:
        return path.join(home, '.profile');
    }
  }

  function readRecord() {
    const { binary, record } = paths();
    const stat = fileStat(record);
    if (!stat?.isFile() || stat.size > 4096) return null;
    const data = JSON.parse(fs.readFileSync(record, 'utf8'));
    if (data.owner !== 'factory-desktop-linux' || data.version !== 1 ||
        data.binary !== binary || !/^[a-f0-9]{64}$/.test(data.sha256) ||
        !Number.isSafeInteger(data.dev) || !Number.isSafeInteger(data.ino)) return null;
    return data;
  }

  function isCliInstalled() {
    try {
      const { binary } = paths();
      const record = readRecord();
      const stat = fileStat(binary);
      return !!(record && stat?.isFile() && sameFile(stat, record) &&
        (stat.mode & 0o111) && digest(binary) === record.sha256);
    } catch {
      return false;
    }
  }

  function installCli(source) {
    const { directory, binary, record } = paths();
    if (isCliInstalled()) return binary;
    if (fileStat(binary) || fileStat(record)) {
      throw new Error(`An existing Droid installation or install record at ${directory} was left unchanged. Manage it with its original installer.`);
    }
    if (!fileStat(source)?.isFile()) throw new Error('The bundled Droid executable is missing.');
    const sha256 = digest(source);
    fs.mkdirSync(directory, { recursive: true });
    let created;
    let recordFd;
    let createdRecord;
    try {
      fs.copyFileSync(source, binary, fs.constants.COPYFILE_EXCL);
      created = fs.lstatSync(binary);
      fs.chmodSync(binary, 0o755);
      if (digest(binary) !== sha256) throw new Error('The installed Droid copy failed its checksum check.');
      recordFd = fs.openSync(record, 'wx', 0o600);
      createdRecord = fs.fstatSync(recordFd);
      fs.writeFileSync(recordFd, `${JSON.stringify({
        owner: 'factory-desktop-linux', version: 1, binary, sha256,
        dev: created.dev, ino: created.ino,
      })}\n`);
      return binary;
    } catch (error) {
      if (sameFile(createdRecord, fileStat(record))) fs.unlinkSync(record);
      if (sameFile(created, fileStat(binary))) fs.unlinkSync(binary);
      throw error;
    } finally {
      if (recordFd !== undefined) fs.closeSync(recordFd);
    }
  }

  function uninstallCli() {
    const { binary, record } = paths();
    if (!fileStat(binary) && !fileStat(record)) return;
    if (!isCliInstalled()) {
      throw new Error('Droid is not an unchanged copy installed by this desktop app. Nothing was removed.');
    }
    fs.unlinkSync(binary);
    fs.unlinkSync(record);
  }

  function updatePath() {
    const directory = installDirectory();
    const entries = (env.PATH || '').split(path.delimiter).filter(Boolean);
    if (entries.some((entry) => path.normalize(entry) === directory)) return false;
    const config = shellConfigPath();
    const line = path.basename(env.SHELL || '') === 'fish'
      ? 'set -gx PATH $HOME/.local/bin $PATH'
      : 'export PATH="$HOME/.local/bin:$PATH"';
    const contents = fileStat(config) ? fs.readFileSync(config, 'utf8') : '';
    if (!contents.split(/\r?\n/).some((existing) => existing.trim() === line)) {
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.appendFileSync(config, `\n# Added by Factory Desktop\n${line}\n`, { mode: 0o600 });
    }
    env.PATH = [directory, ...entries].join(path.delimiter);
    return true;
  }

  return { installDirectory, shellConfigPath, installCli, uninstallCli, isCliInstalled, updatePath };
}

module.exports = { ...createCliIntegration(), createCliIntegration, mergeShellEnvironment };
