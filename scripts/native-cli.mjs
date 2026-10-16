import { detectBuildHost } from './host.mjs';
import { execute, NativeWorkflow } from './native.mjs';
import { packageBackend } from './package-backend.mjs';

const command = process.argv[2] ?? 'help';
const commands = ['build', 'package', 'install', 'update', 'status', 'rollback', 'recover'];
try {
  if (command === 'help' || command === '--help') {
    console.log('Usage: scripts/native.sh build|package|install|update|status|rollback|recover\nUse make bootstrap-native to install native build prerequisites.');
  } else {
    if (!commands.includes(command) || process.argv.length !== 3) throw new Error('Unknown command or extra arguments. Run make help.');
    if (command === 'build') {
      process.env.PACKAGE_WITH_UPDATER = '0';
    } else if (process.env.PACKAGE_WITH_UPDATER !== '0') {
      process.env.PACKAGE_WITH_UPDATER = '1';
    }
    const host = await detectBuildHost();
    if (!host.supported) throw new Error(host.issues.join(' '));
    const packageFormat = host.profile.debPackaging ? 'deb' : 'rpm';
    if (process.env.FACTORY_PACKAGE_FORMAT &&
        process.env.FACTORY_PACKAGE_FORMAT !== packageFormat) {
      throw new Error(`Requested ${process.env.FACTORY_PACKAGE_FORMAT.toUpperCase()} packaging is unavailable on ${host.profile.label}.`);
    }
    if (!host.profile.nativeInstallation && command !== 'build') {
      throw new Error('Ubuntu 24.04 supports portable builds only. Native .deb installation requires Ubuntu 26.04 x86_64.');
    }
    process.env.PACKAGE_FORMAT = packageFormat;
    const workflow = new NativeWorkflow(undefined, undefined, {
      packageBackend: packageBackend(packageFormat),
    });
    if (command === 'status') {
      console.log(JSON.stringify({
        ...await workflow.readState(),
        observedInstalled: workflow.currentIdentity(),
        packageFormat,
      }, null, 2));
    } else if (command === 'update') {
      await workflow.updateCheckout();
    } else if (command === 'rollback') {
      await workflow.install({ rollback: true });
    } else if (command === 'recover') {
      await workflow.recover();
    } else {
      execute('npm', ['run', 'preflight']);
      await workflow.build({
        packageRpm: packageFormat === 'rpm' && command !== 'build',
        packageDeb: packageFormat === 'deb' && command !== 'build',
      });
      if (command === 'install') await workflow.install();
    }
  }
} catch (error) {
  console.error(`native: ${error.message}`);
  process.exitCode = 1;
}
