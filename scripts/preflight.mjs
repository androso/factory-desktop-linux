import { run } from './lib.mjs';
import {
  COMMON_BUILD_COMMANDS,
  FEDORA_RPM_COMMANDS,
  OPTIONAL_BUILD_COMMANDS,
  detectBuildHost,
  packageInstallCommand,
  packagesForMissingPrerequisites,
  requiredCommandsForHost,
} from './host.mjs';

const host = await detectBuildHost();
const issues = [];
const requiredCommands = requiredCommandsForHost(host.profile);
const evidence = {
  checkedAt: new Date().toISOString(),
  requested: {
    distributions: ['Ubuntu 24.04', 'Fedora 44'],
    architecture: 'x86_64',
    fedoraRpmTarget: 'Fedora 44 x86_64 only',
  },
  observed: {
    distribution: host.displayName,
    id: host.id,
    version: host.version,
    architecture: host.machine,
    nodeArchitecture: host.nodeArchitecture,
  },
  supportedHost: host.supported,
  requiredCommands,
  buildCommands: COMMON_BUILD_COMMANDS,
  fedoraRpmCommands: host.profile?.rpmPackaging ? FEDORA_RPM_COMMANDS : [],
  optionalCommands: OPTIONAL_BUILD_COMMANDS,
  missingCommands: [],
  missingRequiredCommands: [],
  missingOptionalCommands: [],
  packages: {
    libsecretDevelopmentFiles: false,
    libsecretDevelopmentPackage: host.profile?.libsecretPackage ?? null,
  },
  missingSystemPackages: [],
  approvalRequired: [],
  sandbox: {
    check: 'unshare -Ur true',
    status: 'not-checked',
    detail: 'This probes user-namespace availability only; it does not validate Electron sandbox startup.',
  },
};

issues.push(...host.issues);

for (const command of evidence.requiredCommands) {
  if (run('sh', ['-c', `command -v '${command}'`]).status !== 0) {
    evidence.missingCommands.push(command);
    evidence.missingRequiredCommands.push(command);
  }
}
if (evidence.missingRequiredCommands.length) {
  issues.push(`Missing required build command(s): ${evidence.missingRequiredCommands.join(', ')}.`);
}

const pkgConfigAvailable = !evidence.missingRequiredCommands.includes('pkg-config');
const libsecret = pkgConfigAvailable ? run('pkg-config', ['--exists', 'libsecret-1']) : { status: 1 };
evidence.packages.libsecretDevelopmentFiles = libsecret.status === 0;
if (!evidence.packages.libsecretDevelopmentFiles) {
  const prerequisite = host.profile?.libsecretPackage ?? 'libsecret-1';
  issues.push(`Required ${prerequisite} development files are missing; no privileged installation was attempted.`);
}

for (const command of evidence.optionalCommands) {
  if (run('sh', ['-c', `command -v '${command}'`]).status !== 0) {
    evidence.missingCommands.push(command);
    evidence.missingOptionalCommands.push(command);
  }
}

if (!evidence.missingOptionalCommands.includes('unshare')) {
  const namespaceProbe = run('unshare', ['-Ur', 'true']);
  evidence.sandbox.status = namespaceProbe.status === 0 ? 'available' : 'blocked';
  if (namespaceProbe.status !== 0) {
    evidence.sandbox.detail = `User-namespace probe failed (${namespaceProbe.status}): ${
      namespaceProbe.combined.trim().slice(0, 1000) || 'no diagnostic output'
    }`;
    if (host.profile?.rpmPackaging) {
      issues.push('Fedora user namespaces are unavailable; normal Electron sandbox behavior is blocked. No workaround was applied.');
    }
  }
} else {
  evidence.sandbox.status = 'unavailable';
  evidence.sandbox.detail = 'The unshare command is missing; Electron sandbox startup was not tested.';
}

evidence.missingSystemPackages = packagesForMissingPrerequisites(
  host.profile ? host : null,
  evidence.missingRequiredCommands,
  !evidence.packages.libsecretDevelopmentFiles,
);
const installCommand = packageInstallCommand(host, evidence.missingSystemPackages);
if (installCommand) {
  evidence.approvalRequired.push({
    action: 'privileged package installation',
    packages: evidence.missingSystemPackages,
    command: installCommand,
  });
}

console.log(JSON.stringify(evidence, null, 2));
if (issues.length) {
  for (const issue of issues) console.error(`preflight: ${issue}`);
  process.exitCode = 1;
}
