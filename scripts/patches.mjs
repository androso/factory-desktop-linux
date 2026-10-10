import { fail } from './lib.mjs';

// Keep the separate native menu bar hidden. The renderer supplies inline menu
// buttons; bare Alt and F10 also open the existing application menu on Linux.
const linuxMenuKeyboardHandler = `
if(process.platform==="linux"){
  let linuxAltMenuPending=false;
  s.on("blur",()=>{linuxAltMenuPending=false});
  s.webContents.on("before-input-event",(event,input)=>{
    if(input.key==="Alt"){
      if(input.type==="keyDown"&&!input.isAutoRepeat){
        linuxAltMenuPending=!input.control&&!input.meta&&!input.shift;
      }else if(input.type==="keyUp"){
        const openMenu=linuxAltMenuPending&&!input.control&&!input.meta&&!input.shift;
        linuxAltMenuPending=false;
        if(openMenu){
          event.preventDefault();
          I.Menu.getApplicationMenu()?.popup({window:s});
        }
      }
      return;
    }
    if(input.type!=="keyDown")return;
    linuxAltMenuPending=false;
    if(input.key==="F10"&&!input.isAutoRepeat&&!input.control&&!input.meta&&!input.shift&&!input.alt){
      event.preventDefault();
      I.Menu.getApplicationMenu()?.popup({window:s});
    }
  });
}
`;

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
  {
    id: 'linux-integrated-window-controls',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'function Zn(e={}){var g,y,m,v;NQ();const t=process.platform==="win32",',
    after: 'function Zn(e={}){var g,y,m,v;NQ();const t=process.platform==="win32"||process.platform==="linux",',
    reason: 'Use the existing hidden title bar, theme-aware overlay controls, and native-theme listener on Linux as well as Windows.',
  },
  {
    id: 'linux-window-controls-zoom',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'process.platform==="win32"&&e.setTitleBarOverlay({height:m9(t)})',
    after: '(process.platform==="win32"||process.platform==="linux")&&e.setTitleBarOverlay({height:m9(t)})',
    reason: 'Align integrated Linux window controls with the renderer title-bar height when app zoom changes.',
  },
  {
    id: 'linux-inline-application-menu-handler',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'if(process.platform!=="win32")return;const n=I.BrowserWindow.fromWebContents(e.sender);',
    after: 'if(process.platform!=="win32"&&process.platform!=="linux")return;const n=I.BrowserWindow.fromWebContents(e.sender);',
    reason: 'Allow the existing validated application-menu popup handler on Linux.',
  },
  {
    id: 'linux-hide-separate-menu-bar',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'process.platform==="win32")for(const l of qo())l.setMenuBarVisibility(!1)',
    after: '(process.platform==="win32"||process.platform==="linux"))for(const l of qo())l.setMenuBarVisibility(!1)',
    reason: 'Keep the separate Linux menu row hidden even when application menus are rebuilt after a locale change.',
  },
  {
    id: 'linux-application-menu-keyboard',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'if(t){s.setMenuBarVisibility(!1);const b=()=>',
    after: `if(t){s.setMenuBarVisibility(!1);${linuxMenuKeyboardHandler}const b=()=>`,
    reason: 'Retain bare Alt and F10 menu access without showing a separate menu bar or intercepting Alt shortcuts.',
  },
  {
    id: 'linux-integrated-header-preload',
    file: '.vite/build/preload.js',
    factoryVersion: '0.194.0',
    before: 'window:{showApplicationMenu:process.platform==="win32"?',
    after: 'window:{showApplicationMenu:(process.platform==="win32"||process.platform==="linux")?',
    reason: 'Enable the existing integrated renderer header, inline menus, drag regions, and overlay space reservation through its capability check.',
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
