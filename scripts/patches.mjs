import { fail } from './lib.mjs';

// Each compatibility change has an exact source precondition and is tied to
// the extracted Factory version. Keep this patch after reproducing the bundled
// behavior: the stock packaged Linux build registers its URI handler during
// startup without user approval.
export const patches = [
  {
    id: 'linux-callback-registration-opt-in',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'process.defaultApp||!I.app.isPackaged?I.app.setAsDefaultProtocolClient(e,process.execPath,[Pe.resolve(process.argv[1]||"")]):I.app.setAsDefaultProtocolClient(e)',
    after: 'process.defaultApp||!I.app.isPackaged?I.app.setAsDefaultProtocolClient(e,process.execPath,[Pe.resolve(process.argv[1]||"")]):process.platform==="linux"?void 0:I.app.setAsDefaultProtocolClient(e)',
    reason: 'Keep the external callback scheme registered only by the explicit desktop integration script on Linux.',
  },
  {
    id: 'linux-disable-minimum-version-poll',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'async function qS(){if(i.getRuntimeAuthConfig().airgapEnabled===!0)',
    after: 'async function qS(){if(process.platform==="linux")return!0;if(i.getRuntimeAuthConfig().airgapEnabled===!0)',
    reason: 'The mandatory version check can trigger a remote update prompt; omit that check for this portable Linux port.',
  },
  {
    id: 'linux-disable-manual-update-handler',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'async function S3({onAborted:e}={}){if(it()&&Is)',
    after: 'async function S3({onAborted:e}={}){if(process.platform==="linux"){e==null||e();return}if(it()&&Is)',
    reason: 'Make any internal/manual updater invocation a no-op on Linux.',
  },
  {
    id: 'linux-disable-update-check-handler',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'async function BS(){_e("check-now-requested"),!(!it()&&await go())&&await qd()}',
    after: 'async function BS(){if(process.platform==="linux")return;_e("check-now-requested"),!(!it()&&await go())&&await qd()}',
    reason: 'Prevent the updates:checkNow IPC handler from polling update metadata on Linux.',
  },
  {
    id: 'linux-hide-update-menu',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'o=!i.getHostedServicesEnabled()||i.areDesktopUpdatesDisabledByCachedOrgSettings()?[]:',
    after: 'o=process.platform==="linux"||!i.getHostedServicesEnabled()||i.areDesktopUpdatesDisabledByCachedOrgSettings()?[]:',
    reason: 'Hide the update menu item on Linux.',
  },
];

export function transformExact(content, patch) {
  if (!patch.id || !patch.factoryVersion || !patch.file || !patch.before || !patch.after) {
    fail('Patch metadata is incomplete.');
  }
  const beforeCount = content.split(patch.before).length - 1;
  if (beforeCount !== 1) {
    fail(`Patch ${patch.id} expected exactly one source match in ${patch.file}, found ${beforeCount}.`);
  }
  if (patch.before === patch.after || content.includes(patch.after)) {
    fail(`Patch ${patch.id} has an invalid or already-applied transformation.`);
  }
  const transformed = content.replace(patch.before, patch.after);
  if (!transformed.includes(patch.after) || transformed.includes(patch.before)) {
    fail(`Patch ${patch.id} regression check failed.`);
  }
  return transformed;
}
