const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Tray,
  Menu,
  nativeImage,
  session,
  shell,
  screen,
} = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs"), path = require("node:path");
const { SiteSessions } = require("./sites.cjs");
const { openGmgnChrome } = require("./chrome.cjs");
const { createWindowPresentation } = require("./window-presentation.cjs");
const windowPresentations = new WeakMap();
app.setName("X-ray Next");
const data = path.join(app.getPath("appData"), "xray-next");
app.setPath("userData", path.join(data, "desktop"));
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
const base = app.isPackaged
  ? path.join(process.resourcesPath, "next")
  : path.resolve(__dirname, "..");
const node = app.isPackaged
  ? path.join(process.resourcesPath, "node", "node.exe")
  : (process.env.XRAY_NODE ?? "node.exe");
const {MonitorClient}=require(path.join(base,'src','infra','monitor-client.cjs'));
const stopOnStart=process.argv.includes('--stop-monitor');
const closeOnStart=process.argv.includes('--close-ui');
const backgroundOnly=process.argv.includes('--background-only')||stopOnStart;
let dashboard,
  overlay,
  closing = false,
  monitor,
  tray;
const sites = new SiteSessions();
const url = "http://127.0.0.1:48876";
// desktop.log rotates past 5 MB into desktop.old.log (one previous copy kept).
const LOG_MAX_BYTES = 5 * 1024 * 1024;
function appendLog(chunk) {
  const logfile = path.join(data, "desktop.log");
  try {
    if (fs.existsSync(logfile) && fs.statSync(logfile).size > LOG_MAX_BYTES) {
      const old = path.join(data, "desktop.old.log");
      try {
        fs.renameSync(logfile, old);
      } catch {
        fs.copyFileSync(logfile, old);
        fs.truncateSync(logfile, 0);
      }
    }
    fs.appendFileSync(logfile, chunk);
  } catch {}
}
function local(sender) {
  try {
    const u = new URL(sender.getURL());
    return u.origin === url;
  } catch {
    return false;
  }
}
function secureWindow(options) {
  const w = new BrowserWindow({
    show: false,
    icon: path.join(__dirname,"app-icon.png"),
    backgroundColor: "#050608",
    ...options,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  windowPresentations.set(w,createWindowPresentation(w));
  let recoveryTimer, recoveryAttempts=0, lastPage=url+'/';
  const logWindow=(event,detail)=>{try{appendLog('[window] '+event+' '+JSON.stringify(detail)+'\n');}catch{}};
  const recover=(reason)=>{
    if(closing||w.isDestroyed()||recoveryTimer)return;
    logWindow('recover',{reason,page:lastPage,attempt:recoveryAttempts+1});
    if(recoveryAttempts>=3){dialog.showErrorBox('界面加载失败','后台数据已保留，请重新打开窗口。');return;}
    recoveryTimer=setTimeout(()=>{recoveryTimer=null;if(!closing&&!w.isDestroyed()){recoveryAttempts++;w.loadURL(lastPage).catch(e=>logWindow('load-error',e.message));}},1500);
  };
  w.webContents.on('did-start-navigation',(_e,target,inPlace,mainFrame)=>{if(mainFrame&&target.startsWith(url+'/'))lastPage=target;});
  w.webContents.on('did-fail-load',(_e,code,description,target,mainFrame)=>{if(mainFrame&&code!==-3){logWindow('load-failed',{code,description,target});recover('load-failed');}});
  w.webContents.on('render-process-gone',(_e,detail)=>{logWindow('renderer-gone',detail);recover('renderer-gone');});
  w.on('unresponsive',()=>{logWindow('unresponsive',lastPage);recover('unresponsive');});
  w.on('responsive',()=>{clearTimeout(recoveryTimer);recoveryTimer=null;});
  w.on('closed',()=>clearTimeout(recoveryTimer));
  w.webContents.on('did-finish-load',()=>{recoveryAttempts=0;});
  w.webContents.on("did-finish-load", () => {
    try {
      fs.writeFileSync(
        path.join(data, "window-status.json"),
        JSON.stringify({
          url: w.webContents.getURL(),
          title: w.webContents.getTitle(),
          at: Date.now(),
        }),
      );
    } catch {}
  });
  w.webContents.on("will-navigate", (e, target) => {
    if (!target.startsWith(url + "/")) e.preventDefault();
  });
  // Token links (target=_blank) open in the system browser; the app itself never opens new windows.
  w.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      const u = new URL(target);
      if (u.protocol === "https:" && (u.hostname === "gmgn.ai" || u.hostname.endsWith(".gmgn.ai"))) void shell.openExternal(u.href);
    } catch {}
    return { action: "deny" };
  });
  return w;
}
function openDashboard() {
  if (!dashboard || dashboard.isDestroyed()) {
    dashboard = secureWindow({
      ...dashboardBounds(),
      center: true,
      title: "X-ray Dashboard",
      backgroundColor: "#050608",
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#050608", symbolColor: "#a9b1c0", height: 34 },
    });
    dashboard.loadURL(url + "/?native=1");
    dashboard.on('closed',()=>{dashboard=null;});
  }
  windowPresentations.get(dashboard).show({focus:true});
}
function openOverlay(inactive = false) {
  if (!overlay || overlay.isDestroyed()) {
    overlay = secureWindow({
      ...defaultOverlayBounds(),
      frame: false,
      alwaysOnTop: true,
      title: "X-ray Next · 实时监控",
      transparent: true,
      backgroundColor: "#00000000",
      skipTaskbar: true,
      hasShadow: true,
      resizable: true,
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true});
    overlay.loadURL(url + "/overlay");
    overlay.on("close", (e) => {
      if (!closing) {
        e.preventDefault();
        windowPresentations.get(overlay).hide();
      }
    });
  }
  if(overlayBounds){overlay.setResizable(true);overlay.setHasShadow(true);overlay.setBounds(clampOverlayBounds(overlayBounds),false);overlayBounds=null;overlay.webContents.send('overlay:mode',false);}
  windowPresentations.get(overlay).show({inactive});
  return { ok: true };
}
ipcMain.handle("dashboard", (e, page) => {
  if (!local(e.sender)) throw Error("来源不允许");
  openDashboard();
  if(['overview','groups','stats','audit','settings'].includes(page)) dashboard.loadURL(url+'/?native=1&page='+page);
});
ipcMain.handle('open-url', (e, raw) => {
  if(!local(e.sender))throw Error('来源不允许');
  const u=new URL(raw);if(u.protocol!=='https:')throw Error('仅允许 HTTPS');
  return shell.openExternal(u.href);
});
ipcMain.handle('open-gmgn-chrome', (e, raw) => {
  if (!local(e.sender)) throw Error('来源不允许');
  return openGmgnChrome(raw);
});
ipcMain.handle('wake-overlay-for-urgent', (e) => {
  if (!local(e.sender)) throw Error('来源不允许');
  if (!overlay || overlay.isDestroyed() || !overlay.isVisible() || overlayBounds)
    return openOverlay(true);
  return { ok: true, alreadyVisible: true };
});
let overlayBounds,dragStart;
function defaultOverlayBounds(){const {workArea}=screen.getPrimaryDisplay();return {x:workArea.x,y:workArea.y+20,width:360,height:Math.min(700,workArea.height-40)};}
function dashboardBounds(){const {width:w,height:h}=screen.getPrimaryDisplay().workAreaSize;return {width:Math.min(1487,Math.max(Math.min(1000,w),Math.floor(w*.92))),height:Math.min(1058,Math.max(Math.min(700,h),Math.floor(h*.92))),minWidth:Math.min(1000,w),minHeight:Math.min(700,h)};}
function clampOverlayBounds(b,size){const a=screen.getDisplayMatching(b).workArea,w=Math.min(size||b.width,a.width),h=Math.min(size||b.height,a.height);return {x:Math.max(a.x,Math.min(b.x,a.x+a.width-w)),y:Math.max(a.y,Math.min(b.y,a.y+a.height-h)),width:w,height:h};}
ipcMain.handle('overlay-collapsed', (e, value) => {
  if(e.sender!==overlay?.webContents||!local(e.sender))throw Error('来源不允许');
  if(value){if(overlayBounds)return;overlayBounds=overlay.getBounds();overlay.setResizable(false);overlay.setHasShadow(false);overlay.setBounds(clampOverlayBounds(overlayBounds,56),false);}
  else {overlay.setResizable(true);overlay.setHasShadow(true);overlay.setBounds(clampOverlayBounds(overlayBounds??defaultOverlayBounds()),false);overlayBounds=null;}
});
ipcMain.on('overlay-drag-start',e=>{if(e.sender===overlay?.webContents&&local(e.sender))dragStart={point:screen.getCursorScreenPoint(),bounds:overlay.getBounds()};});
ipcMain.on('overlay-drag-move',e=>{if(e.sender!==overlay?.webContents||!local(e.sender)||!dragStart)return;const p=screen.getCursorScreenPoint();overlay.setBounds(clampOverlayBounds({...dragStart.bounds,x:dragStart.bounds.x+p.x-dragStart.point.x,y:dragStart.bounds.y+p.y-dragStart.point.y},56),false);});
ipcMain.on('overlay-drag-end',()=>{dragStart=null;});
ipcMain.handle("hide-overlay", (e) => {
  if (e.sender !== overlay?.webContents || !local(e.sender))
    throw Error("来源不允许");
  windowPresentations.get(overlay).hide();
  openDashboard();
});
ipcMain.handle("opacity", (e, value) => {
  if (
    e.sender !== overlay?.webContents ||
    !local(e.sender) ||
    !Number.isFinite(value) ||
    value < 0.3 ||
    value > 1
  )
    return;
  overlay.setOpacity(value);
});
async function configureKeys() {
  const answer = await dialog.showMessageBox(dashboard, {
    type: "question",
    title: "微信读取配置",
    message: "请选择配置方式",
    detail: "密钥仅用于本机只读访问微信消息数据库，保存在新项目独立目录。",
    buttons: ["导入密钥文件", "运行本机提取工具", "取消"],
    cancelId: 2,
  });
  if (answer.response === 2) return { cancelled: true };
  if (answer.response === 0) {
    const f = await dialog.showOpenDialog(dashboard, {
      properties: ["openFile"],
      filters: [{ name: "微信密钥文件", extensions: ["json"] }],
    });
    if (f.canceled) return { cancelled: true };
    const raw = fs.readFileSync(f.filePaths[0], "utf8"),
      parsed = JSON.parse(raw);
    if (
      !Object.values(parsed).some(
        (v) =>
          v && typeof v === "object" && /^[\da-f]{64}$/i.test(v.enc_key ?? ""),
      )
    )
      throw Error("不是有效微信密钥文件");
    fs.mkdirSync(path.join(data, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(data, "secrets", "all_keys.json"), raw, {
      mode: 0o600,
    });
    return { ok: true };
  }
  const env = { ...process.env, XRAY_DATA_DIR: data, FOMOMO_DATA_DIR: data };
  if (app.isPackaged)
    env.XRAY_BUNDLED_PYTHON = path.join(
      process.resourcesPath,
      "python",
      "python.exe",
    );
  const script = path.join(base, "scripts", "setup-keys.ps1");
  const ps = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    { env, cwd: base, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let tail = "";
    ps.stdout.on("data", (b) => (tail = (tail + b.toString()).slice(-1000)));
    ps.stderr.on("data", (b) => (tail = (tail + b.toString()).slice(-1000)));
    ps.on("error", reject);
    ps.on("exit", (code) =>
      code === 0
        ? resolve({ ok: true })
        : reject(Error("微信读取配置失败，请检查微信是否运行。")),
    );
  });
}
async function dispatch(method, params, signal) {
  if (method === 'desktop.memory') {
    const roles=new Map();
    for(const w of BrowserWindow.getAllWindows()) {
      const role=w===overlay?'overlay':w===dashboard?'dashboard':w===sites.searchWindow?'ave-search':'site';
      roles.set(w.webContents.getOSProcessId(),role);
    }
    return app.getAppMetrics().map(p=>({pid:p.pid,type:p.type,role:roles.get(p.pid)??p.type,workingSetKB:p.memory.workingSetSize,privateKB:p.memory.privateBytes}));
  }
  if (method === "ave.query") return sites.aveQuery(params, signal);
  if (method === "ave.search-address") return sites.aveSearchAddress(params, signal);
  if (method === "site.open") return sites.open(params.provider);
  if (method === "desktop.action") {
    if (params.action === "overlay") return openOverlay();
    if (params.action === "keys") return configureKeys();
  }
  throw Error("未知桌面请求");
}
function startBackend() {
  if (closing) return;
  monitor=new MonitorClient({data,base,node,desktop:{exe:process.execPath,args:app.isPackaged?[]:[__filename]},dispatch,log:appendLog});
  monitor.start();
}
async function stopMonitoringAndQuit(){
  try{await monitor.stopService();app.quit();}
  catch(error){dialog.showErrorBox('未能确认监控停止',error.message);}
}
app.whenReady().then(async () => {
  if(closeOnStart){app.quit();return;}
  Menu.setApplicationMenu(null);
  await session.defaultSession.setProxy({ mode: "direct" });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(
    path.join(data, "runtime.json"),
    JSON.stringify(
      {
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        desktopBuild: '20261118-delivery-trace',
      },
      null,
      2,
    ),
  );
  tray = new Tray(
    nativeImage.createFromPath(path.join(__dirname, "tray.png")),
  );
  tray.setToolTip("X-ray");
  const trayMenu=Menu.buildFromTemplate([
      { label: "显示面板", click: openOverlay },
      { label: "隐藏面板", click: ()=>windowPresentations.get(overlay)?.hide() },
      { type: "separator" },
      { label: "打开 Dashboard", click: openDashboard },
      { type: "separator" },
      { label: "关闭界面（继续监控）", click: () => app.quit() },
      { label: "停止监控并退出", click: stopMonitoringAndQuit },
    ]);
  tray.setContextMenu(trayMenu);
  tray.on('click',()=>tray.popUpContextMenu(trayMenu));
  tray.on('right-click',()=>tray.popUpContextMenu(trayMenu));
  tray.on("double-click", openOverlay);
  startBackend();
  for (let n = 0; n < 80; n++) {
    try {
      const r = await fetch(url + "/api/ready",{signal:AbortSignal.timeout(1000)});
      if (r.ok && (await r.json()).ok) {
        if(stopOnStart){if(monitor.connected){await stopMonitoringAndQuit();return;}await new Promise(resolve=>setTimeout(resolve,250));continue;}
        if(!backgroundOnly)openOverlay();
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  dialog.showErrorBox("启动超时", "请查看独立数据目录里的 monitor-service.log 和 desktop.log。");
});
app.on("second-instance", (_event,argv) => {
  if(argv.includes('--stop-monitor'))void stopMonitoringAndQuit();
  else if(argv.includes('--close-ui'))app.quit();
  else if(!argv.includes('--background-only'))openOverlay();
});
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  closing = true;
  sites.close();
  monitor?.close();
});
