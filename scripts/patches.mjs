import { readFile } from 'node:fs/promises';
import { fail, walkFiles } from './lib.mjs';
import { mergeDaemonModelCatalog } from './model-catalog.mjs';

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

const linuxUpdateManagerIpc = `(()=>{
function factoryLinuxUpdateSender(e){
  try{
    const w=I.BrowserWindow.fromWebContents(e.sender);
    return !!w&&!w.isDestroyed()&&e.senderFrame===e.sender.mainFrame&&
      e.senderFrame.url.startsWith("file://"+process.resourcesPath+"/app.asar/");
  }catch{return!1}
}
async function factoryLinuxUpdateManager(a,capture=!1){
  const{spawn}=await import("node:child_process");
  return await new Promise((resolve,reject)=>{
    const child=spawn("/usr/bin/factory-update-manager",a,{
      stdio:capture?["ignore","pipe","pipe"]:["ignore","ignore","pipe"]
    });
    let out="",err="";
    if(capture)child.stdout.setEncoding("utf8").on("data",x=>{if(out.length<65536)out+=x.slice(0,65536-out.length)});
    child.stderr.setEncoding("utf8").on("data",x=>{if(err.length<8192)err+=x.slice(0,8192-err.length)});
    child.once("error",reject);
    child.once("close",(code,signal)=>{
      if(code!==0)reject(new Error(err||"Factory update manager failed"));
      else resolve(capture?out:null);
    });
  });
}
async function factoryLinuxUpdatePolicy(){
  const r=i.getRuntimeAuthConfig?.()||{};
  const hosted=i.getHostedServicesEnabled()===!0;
  const airgap=r.airgapEnabled===!0;
  const organization=i.areDesktopUpdatesDisabledByCachedOrgSettings()===!0;
  await factoryLinuxUpdateManager(["policy",hosted?"1":"0",airgap?"1":"0",organization?"1":"0"]);
  return hosted&&!airgap&&!organization;
}
function factoryLinuxUpdateUi(s){
  if(s.phase==="Checking"||s.phase==="Building")return{kind:"checking"};
  if(s.phase==="Blocked"){
    if(s.policy&&(!s.policy.hostedServicesEnabled||s.policy.airgapEnabled||s.policy.organizationUpdatesDisabled))
      return{kind:"disabled"};
    return{kind:"error",message:s.error||"The Linux update could not be prepared."};
  }
  if(s.ready)return{
    kind:"available",
    currentVersion:I.app.getVersion(),
    latestVersion:s.candidateVersion||s.latestVersion,
    versionsBehind:1,
    releasedAt:s.lastCheckAt||void 0
  };
  return{kind:"idle"};
}
async function factoryLinuxUpdateStatus(){
  const raw=await factoryLinuxUpdateManager(["status"],!0);
  return JSON.parse(raw);
}
if(process.platform==="linux"){
  setTimeout(()=>{
    void(async()=>{
      try{
        if(await factoryLinuxUpdatePolicy())
          await factoryLinuxUpdateManager(["check","--background"]);
      }catch(e){i.logWarn("[linux-updater] Startup check failed",{cause:e})}
    })();
  },15000);
}
I.ipcMain.handle("updates:getState",async e=>{
  if(process.platform!=="linux")return _3();
  if(!factoryLinuxUpdateSender(e))throw new Error("Rejected Linux updater IPC sender.");
  try{
    await factoryLinuxUpdatePolicy();
    return factoryLinuxUpdateUi(await factoryLinuxUpdateStatus());
  }catch(e){return{kind:"error",message:e instanceof Error?e.message:"Linux update manager unavailable"}}
});
I.ipcMain.handle("updates:install",async e=>{
  if(process.platform!=="linux"){i.getHostedServicesEnabled()&&await S3();return}
  if(!factoryLinuxUpdateSender(e))throw new Error("Rejected Linux updater IPC sender.");
  if(!await factoryLinuxUpdatePolicy())return{kind:"disabled"};
  const prepared=JSON.parse(await factoryLinuxUpdateManager(["prepare-handoff"],!0));
  if(!prepared.prepared)return{kind:"idle"};
  const timer=setTimeout(()=>{void factoryLinuxUpdateManager(["cancel-handoff"]).catch(()=>{})},120000);
  I.app.once("will-quit",()=>clearTimeout(timer));
  I.app.quit();
  return{kind:"checking"};
});
I.ipcMain.handle("updates:checkNow",async e=>{
  if(process.platform!=="linux"){
    if(i.getHostedServicesEnabled())try{await BS()}catch(y){i.logWarn("[updates:checkNow] Poll failed",{cause:y})}
    return;
  }
  if(!factoryLinuxUpdateSender(e))throw new Error("Rejected Linux updater IPC sender.");
  try{
    if(!await factoryLinuxUpdatePolicy()){Je({kind:"disabled"});return{kind:"disabled"}}
    await factoryLinuxUpdateManager(["check","--now"]);
    const state=factoryLinuxUpdateUi(await factoryLinuxUpdateStatus());
    Je(state);
    return state;
  }catch(e){
    const state={kind:"error",message:e instanceof Error?e.message:"Linux update check failed"};
    Je(state);
    return state;
  }
});
})()`;

// Each compatibility change has an exact source precondition and is tied to
// the extracted Factory version. Keep this patch after reproducing the bundled
// behavior: the stock packaged Linux build registers its URI handler during
// startup without user approval.
export const patches = [
  {
    id: 'linux-daemon-model-catalog-helper',
    file: '.vite/renderer/main_window/assets/index-CxnMow3h.js',
    factoryVersion: '0.194.0',
    before: 'function aro(t){return t.isCustom===!0||t.id.startsWith("custom:")}function Sne(t)',
    after: `function aro(t){return t.isCustom===!0||t.id.startsWith("custom:")}\n${mergeDaemonModelCatalog.toString()}\nfunction Sne(t)`,
    reason: 'Retain newer daemon-provided built-in models and disabled states without bypassing custom-model policy or forcing preview flags.',
  },
  {
    id: 'linux-main-session-model-disabled-schema',
    file: '.vite/build/index-US6E2OoJ.js',
    factoryVersion: '0.194.0',
    before: 'Jk=dE,T1=o.object(',
    after: 'Jk=ow,T1=o.object(',
    reason: 'Keep session model disabled metadata intact across main-process schema parsing as well as renderer parsing.',
  },
  {
    id: 'linux-session-model-disabled-schema',
    file: '.vite/renderer/main_window/assets/index-CxnMow3h.js',
    factoryVersion: '0.194.0',
    before: 'fkt=lmt,tnr=V.object(',
    after: 'fkt=Sti,tnr=V.object(',
    reason: 'Preserve optional disabled states and reasons when parsing session model catalogs.',
  },
  {
    id: 'linux-new-session-daemon-models',
    file: '.vite/renderer/main_window/assets/index-CxnMow3h.js',
    factoryVersion: '0.194.0',
    before: 'q=K!==void 0?D?RNe(K):J8([...$??K.filter(Ie=>!aro(Ie)),...Sne(K)],j?.modelPolicy):',
    after: 'q=K!==void 0?D?RNe(K):mergeDaemonModelCatalog(J8([...$??K.filter(Ie=>!aro(Ie)),...Sne(K)],j?.modelPolicy),K):',
    reason: 'Do not replace a new chat daemon catalog with the older frontend built-in list.',
  },
  {
    id: 'linux-chat-daemon-model-state',
    file: '.vite/renderer/main_window/assets/index-CxnMow3h.js',
    factoryVersion: '0.194.0',
    before: 'return dt&&dt.length>0?Sne(dt):Sne(_&&_.customModels.length>0?_.customModels:s.availableModels)',
    after: 'return dt&&dt.length>0?dt:(_&&_.customModels.length>0?_.customModels:s.availableModels)',
    reason: 'Keep built-in entries in the session model state instead of retaining only custom models.',
  },
  {
    id: 'linux-chat-daemon-model-updates',
    file: '.vite/renderer/main_window/assets/index-CxnMow3h.js',
    factoryVersion: '0.194.0',
    before: 'ot!=null&&j(Sne(ot))',
    after: 'ot!=null&&j(ot)',
    reason: 'Retain newer built-in models when a loaded session refreshes its catalog.',
  },
  {
    id: 'linux-chat-daemon-model-catalog',
    file: '.vite/renderer/main_window/assets/index-CxnMow3h.js',
    factoryVersion: '0.194.0',
    before: 'const m=n?[]:J8(dB(a,i),o);',
    after: 'const m=n?[]:mergeDaemonModelCatalog(J8(dB(a,i),o),s);',
    reason: 'Merge daemon built-ins after the existing frontend policy checks, preserving restrictions from either source.',
  },
  {
    id: 'linux-chat-live-daemon-model-catalog',
    file: '.vite/renderer/main_window/assets/index-CxnMow3h.js',
    factoryVersion: '0.194.0',
    before: 'h=m=>n?RNe(m):[...l,...d(m).filter(KGc)]',
    after: 'h=m=>n?RNe(m):[...mergeDaemonModelCatalog(l,m).filter(JGc),...d(m).filter(KGc)]',
    reason: 'Include newer authorized built-ins in immediate settings updates as well as subsequent renders.',
  },
  {
    id: 'linux-automation-daemon-catalog-query',
    file: '.vite/renderer/main_window/assets/index-CxnMow3h.js',
    factoryVersion: '0.194.0',
    before: 'p=o&&(h?f(t):t===Ti&&vo()&&u===Bi.Connected)',
    after: 'p=h?f(t):t===Ti&&vo()&&u===Bi.Connected',
    reason: 'Read the connected target catalog even when the separate BYOK automation feature is off.',
  },
  {
    id: 'linux-automation-custom-model-feature-guard',
    file: '.vite/renderer/main_window/assets/index-CxnMow3h.js',
    factoryVersion: '0.194.0',
    before: 'const w=(b?.availableModels??[]).filter(Twc),',
    after: 'const w=(o?b?.availableModels??[]:[]).filter(Twc),',
    reason: 'Keep automation custom models behind their existing BYOK feature flag when fetching built-in catalogs.',
  },
  {
    id: 'linux-automation-daemon-model-catalog',
    file: '.vite/renderer/main_window/assets/index-CxnMow3h.js',
    factoryVersion: '0.194.0',
    before: 'k=[...J8([...E,...T],a),..._?w:[]].filter(Ewc).map(xwc)',
    after: 'k=[...mergeDaemonModelCatalog(J8([...E,...T],a),b?.availableModels),..._?w:[]].filter(Ewc).map(xwc)',
    reason: 'Retain daemon built-ins in automation selectors while filtering disabled entries and respecting custom-model controls.',
  },
  {
    id: 'linux-preserve-launcher-environment',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'Object.assign(process.env,i.mergeShellEnvironment(process.env,t??{}))',
    after: 'Object.assign(process.env,process.platform==="linux"?require(process.resourcesPath+"/linux-cli.cjs").mergeShellEnvironment(process.env,i.mergeShellEnvironment(process.env,t??{})):i.mergeShellEnvironment(process.env,t??{}))',
    reason: 'Load the official login-shell environment without allowing shell startup files to replace the selected Linux profile or launcher guards.',
  },
  {
    id: 'linux-cli-user-install-directory',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'function cs(){return Xr?X.join(i.getDesktopHomeDir(),"bin"):X.join(i.getDesktopHomeDir(),".local","bin")}',
    after: 'function cs(){return process.platform==="linux"?require(process.resourcesPath+"/linux-cli.cjs").installDirectory():Xr?X.join(i.getDesktopHomeDir(),"bin"):X.join(i.getDesktopHomeDir(),".local","bin")}',
    reason: 'Install the optional terminal command into the real user home, not the isolated Factory profile.',
  },
  {
    id: 'linux-cli-user-shell-config',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'function N8(){const e=process.env.SHELL||"";',
    after: 'function N8(){if(process.platform==="linux")return require(process.resourcesPath+"/linux-cli.cjs").shellConfigPath();const e=process.env.SHELL||"";',
    reason: 'Use the user shell configuration, including ZDOTDIR and the original fish XDG config directory.',
  },
  {
    id: 'linux-cli-safe-install',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'async function sX(){const e=cs();',
    after: 'async function sX(){if(process.platform==="linux")return require(process.resourcesPath+"/linux-cli.cjs").installCli(oX());const e=cs();',
    reason: 'Keep the official opt-in CLI installation flow while refusing to overwrite another Droid installation.',
  },
  {
    id: 'linux-cli-owned-uninstall',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'async function aX(){const e=["droid"],t=L8();',
    after: 'async function aX(){if(process.platform==="linux")return require(process.resourcesPath+"/linux-cli.cjs").uninstallCli();const e=["droid"],t=L8();',
    reason: 'Only uninstall an unchanged CLI copy that this port installed and recorded.',
  },
  {
    id: 'linux-cli-owned-status',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'function qp(){const e=Gp("droid");',
    after: 'function qp(){if(process.platform==="linux")return require(process.resourcesPath+"/linux-cli.cjs").isCliInstalled();const e=Gp("droid");',
    reason: 'Do not treat an independently installed or replaced Droid executable as desktop-managed.',
  },
  {
    id: 'linux-cli-shell-path',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'async function cX(){const e=cs(),t=N8(),n=X.basename(process.env.SHELL||"bash");',
    after: 'async function cX(){if(process.platform==="linux")try{return require(process.resourcesPath+"/linux-cli.cjs").updatePath()}catch(e){i.logError("[cli-installer] Failed to update shell config",{cause:e});return!1}const e=cs(),t=N8(),n=X.basename(process.env.SHELL||"bash");',
    reason: 'Update the real shell configuration once, without mistaking a commented .local/bin mention for a working PATH export.',
  },
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
    id: 'linux-update-manager-ipc',
    mode: 'managed',
    file: '.vite/build/initLifecycle-C99OJOv_.js',
    factoryVersion: '0.194.0',
    before: 'I.ipcMain.handle("updates:getState",async()=>_3()),I.ipcMain.handle("updates:install",async()=>{i.getHostedServicesEnabled()&&await S3()}),I.ipcMain.handle("updates:checkNow",async()=>{if(i.getHostedServicesEnabled())try{await BS()}catch(y){i.logWarn("[updates:checkNow] Poll failed",{cause:y})}})',
    after: linuxUpdateManagerIpc,
    reason: 'Route Linux update status, check, and restart requests through the fixed user manager and validated private IPC.',
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

export function patchesForBuild({ withUpdater = false } = {}) {
  return patches.filter((patch) => {
    if (patch.mode === 'managed') return withUpdater;
    if (withUpdater && patch.id === 'linux-hide-update-menu') return false;
    return true;
  });
}

export async function findUniquePatchFile(appDirectory, patch, {
  files = null,
  contents = null,
} = {}) {
  const candidates = (files ?? await walkFiles(appDirectory))
    .filter((file) => /\.(?:js|cjs|mjs)$/i.test(file));
  const matches = [];
  for (const file of candidates) {
    let content = contents?.get(file);
    if (content === undefined) {
      content = await readFile(file, 'utf8');
      contents?.set(file, content);
    }
    const count = content.split(patch.before).length - 1;
    if (count) matches.push({ file, count });
  }
  if (matches.length !== 1 || matches[0].count !== 1) {
    fail(`Patch ${patch.id} expected one unique source precondition in the app bundle, found ${
      matches.reduce((total, item) => total + item.count, 0)
    } across ${matches.length} file(s).`);
  }
  return matches[0].file;
}

export function transformExact(content, patch) {
  if (!patch.id || !patch.file || !patch.before || !patch.after) {
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
