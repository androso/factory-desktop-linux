import { readOsRelease, run } from './lib.mjs';

const osRelease = await readOsRelease();
const issues = [];
const evidence = {
  checkedAt: new Date().toISOString(),
  requested: { distribution: 'Ubuntu 24.04', architecture: 'x64' },
  observed: {
    distribution: osRelease.PRETTY_NAME ?? `${osRelease.ID ?? 'unknown'} ${osRelease.VERSION_ID ?? ''}`.trim(),
    id: osRelease.ID ?? null,
    version: osRelease.VERSION_ID ?? null,
    architecture: run('uname', ['-m']).stdout.trim(),
  },
  requiredCommands: ['node', 'npm', 'pkg-config', 'gcc', 'g++', 'make', 'python3'],
  optionalCommands: ['Xvfb', 'xvfb-run', 'dbus-run-session', 'xdg-mime'],
  missingCommands: [],
  packages: {
    libsecretDevelopmentFiles: false,
  },
  approvalRequired: [],
};

if (evidence.observed.id !== 'ubuntu' || evidence.observed.version !== '24.04') {
  issues.push(`Expected Ubuntu 24.04, found ${evidence.observed.distribution}.`);
}
if (evidence.observed.architecture !== 'x86_64') {
  issues.push(`Expected x86_64, found ${evidence.observed.architecture}.`);
}

for (const command of evidence.requiredCommands) {
  if (run('sh', ['-c', `command -v '${command}'`]).status !== 0) {
    evidence.missingCommands.push(command);
  }
}
if (evidence.missingCommands.length) {
  issues.push(`Missing required build command(s): ${evidence.missingCommands.join(', ')}.`);
}

const libsecret = run('pkg-config', ['--exists', 'libsecret-1']);
evidence.packages.libsecretDevelopmentFiles = libsecret.status === 0;
if (!evidence.packages.libsecretDevelopmentFiles) {
  evidence.approvalRequired.push({
    action: 'privileged package installation',
    package: 'libsecret-1-dev',
    command: 'sudo apt-get install libsecret-1-dev',
  });
  issues.push('libsecret-1 development files are missing; no privileged installation was attempted.');
}

for (const command of evidence.optionalCommands) {
  if (run('sh', ['-c', `command -v '${command}'`]).status !== 0) {
    evidence.missingCommands.push(command);
  }
}

console.log(JSON.stringify(evidence, null, 2));
if (issues.length) {
  for (const issue of issues) console.error(`preflight: ${issue}`);
  process.exitCode = 1;
}
