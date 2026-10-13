import { ROOT } from './lib.mjs';
import { detectBuildHost } from './host.mjs';
import { backendForHost, execute, NativeWorkflow } from './native.mjs';

const command = process.argv[2] ?? 'help';
const commands = ['build', 'package', 'install', 'update', 'status', 'rollback', 'recover'];
try {
  if (command === 'help' || command === '--help') {
    console.log('Usage: scripts/native.sh build|package|install|update|status|rollback|recover\nUse make bootstrap-native to install build prerequisites first.');
  } else {
    if (!commands.includes(command) || process.argv.length !== 3) throw new Error('Unknown command or extra arguments. Run make help.');
    const host = await detectBuildHost();
    const backend = backendForHost(host);
    if (!host.supported || !backend) {
      throw new Error('Native workflow supports Ubuntu 24.04 or newer, or Fedora 44, on x86_64 only.');
    }
    const workflow = new NativeWorkflow(ROOT, execute, { backend });
    if (command === 'status') {
      console.log(JSON.stringify({ ...await workflow.readState(), observedInstalled: backend.installedIdentity() }, null, 2));
    } else if (command === 'update') {
      await workflow.updateCheckout();
    } else if (command === 'rollback') {
      await workflow.install({ rollback: true });
    } else if (command === 'recover') {
      await workflow.recover();
    } else {
      execute('npm', ['run', 'preflight']);
      await workflow.build({ packageArtifact: command !== 'build' });
      if (command === 'install') await workflow.install();
    }
  }
} catch (error) {
  console.error(`native: ${error.message}`);
  process.exitCode = 1;
}
