// Gabriele overlay — runs on the gaming PC (or locally for testing).
// A transparent, always-on-top, click-through window that floats over the game.
// It NEVER injects into the game process: it's a separate top-most window the OS
// composites on top. Three visibility states: hidden / glance / focused.

const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, Notification, systemPreferences, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');

// Keep the overlay painting while a game is the foreground/occluding window.
// This matters most on Windows, where Chromium's native occlusion tracking can
// throttle a transparent topmost window behind a borderless fullscreen game.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

app.setName('Gabriele');

// Bridge location. Local test: 127.0.0.1. On the gaming PC, set
// GABRIELE_URL=ws://<mac-lan-ip>:4848 (your Mac is 172.20.6.188).
const WS_URL = process.env.GABRIELE_URL || 'ws://127.0.0.1:4848';
const TOKEN = process.env.GABRIELE_TOKEN || '';                           // set => relay/auth mode
const HOTKEY = process.env.GABRIELE_HOTKEY || 'Alt+Shift+Tab';            // summon(type) / hide
const GLANCE_HOTKEY = process.env.GABRIELE_GLANCE_HOTKEY || 'Alt+Shift+G'; // glance / hide
const DEV_RELOAD = process.env.GABRIELE_DEV === '1';
const DISPLAY_INDEX = Number.parseInt(process.env.GABRIELE_DISPLAY || '', 10);
const W = envInt('GABRIELE_WIDTH', 600);
const H = envInt('GABRIELE_HEIGHT', 640);
const MARGIN = envInt('GABRIELE_MARGIN', 24);
const COMPLETION_PEEK_MS = envInt('GABRIELE_COMPLETION_PEEK_MS', 2200);

let win, tray;
let state = 'glance'; // 'hidden' | 'glance' | 'focused'
let visibilityPulse = null;
let devReloadTimer = null;
let completionPeekTimer = null;
let lastActiveMacApp = null;
const devReloadMtimes = new Map();
const devWatchers = [];

const MAC_FRONTMOST_APP_SCRIPT = `
ObjC.import('AppKit');
const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
const bundleId = ObjC.unwrap(front.bundleIdentifier) || '';
const name = ObjC.unwrap(front.localizedName) || '';
console.log([front.processIdentifier, bundleId, name].join('\\n'));
`;

const MAC_ACTIVATE_APP_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  const pid = Number(argv[0] || 0);
  const bundleId = argv[1] || '';
  let target = pid > 0 ? $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid) : null;
  if (!target && bundleId) {
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId);
    if (apps.count > 0) target = apps.objectAtIndex(0);
  }
  if (target) {
    target.activateWithOptions($.NSApplicationActivateIgnoringOtherApps | $.NSApplicationActivateAllWindows);
  }
}
`;

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function overlayDisplay() {
  const displays = screen.getAllDisplays();
  if (Number.isInteger(DISPLAY_INDEX) && displays[DISPLAY_INDEX]) return displays[DISPLAY_INDEX];
  return screen.getPrimaryDisplay();
}

function placeWindow() {
  if (!win || win.isDestroyed()) return;
  const { bounds } = overlayDisplay();
  win.setBounds({
    width: W,
    height: H,
    x: bounds.x + bounds.width - W - MARGIN,
    y: bounds.y + bounds.height - H - MARGIN,
  }, false);
}

function pinToGameLayer() {
  if (!win || win.isDestroyed()) return;

  try {
    if (process.platform === 'darwin') win.setAlwaysOnTop(true, 'screen-saver', 1);
    else win.setAlwaysOnTop(true, 'screen-saver');
  } catch (err) {
    console.warn(`[gabriele] screen-saver topmost failed; falling back to default topmost: ${err.message}`);
    win.setAlwaysOnTop(true);
  }

  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  } catch {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  if (typeof win.moveTop === 'function') win.moveTop();
}

function reassertGameVisibility() {
  if (!win || win.isDestroyed() || state === 'hidden') return;
  if (!win.isVisible()) {
    if (state === 'focused') win.show();
    else win.showInactive();
  }
  pinToGameLayer();
}

function startVisibilityPulse() {
  clearInterval(visibilityPulse);
  visibilityPulse = setInterval(reassertGameVisibility, 1000);
  if (visibilityPulse.unref) visibilityPulse.unref();
}

function rememberMacActiveApp() {
  if (process.platform !== 'darwin') return;
  lastActiveMacApp = null;
  try {
    const out = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_FRONTMOST_APP_SCRIPT], {
      encoding: 'utf8',
      timeout: 700,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const [pidLine, bundleId = '', ...nameParts] = out.split('\n');
    const info = {
      pid: Number(pidLine) || 0,
      bundleId: bundleId.trim(),
      name: nameParts.join('\n').trim(),
    };
    if (!info.pid && !info.bundleId && !info.name) return;
    if (isOwnMacApp(info)) return;
    lastActiveMacApp = info;
    console.log(`[gabriele] remember app: ${formatMacApp(info)}`);
  } catch {}
}

function restoreMacActiveApp() {
  if (process.platform !== 'darwin' || !lastActiveMacApp) return;
  const target = lastActiveMacApp;
  console.log(`[gabriele] restore app: ${formatMacApp(target)}`);
  setTimeout(() => activateMacApp(target, 'primary'), 40);
  if (target.bundleId) setTimeout(() => openMacApp(target), 160);
  setTimeout(() => activateMacApp(target, 'retry'), 320);
}

function isOwnMacApp(info) {
  if (!info) return true;
  if (info.pid === process.pid) return true;
  const ownName = app.getName().toLowerCase();
  const appName = String(info.name || '').toLowerCase();
  return appName === ownName || appName === 'electron';
}

function activateMacApp(target, label) {
  execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_ACTIVATE_APP_SCRIPT, String(target.pid || 0), target.bundleId || ''], { timeout: 1200 }, (err) => {
    if (err) console.warn(`[gabriele] could not restore ${formatMacApp(target)} (${label}): ${err.message}`);
  });
}

function openMacApp(target) {
  execFile('/usr/bin/open', ['-b', target.bundleId], { timeout: 1200 }, (err) => {
    if (err) console.warn(`[gabriele] could not open ${formatMacApp(target)}: ${err.message}`);
  });
}

function formatMacApp(info) {
  return `${info.name || info.bundleId || 'unknown'} pid=${info.pid || '?'} bundle=${info.bundleId || '-'}`;
}

function cancelCompletionPeek() {
  clearTimeout(completionPeekTimer);
  completionPeekTimer = null;
}

function showCompletionPeek() {
  if (!win || win.isDestroyed() || state !== 'hidden') return;
  cancelCompletionPeek();
  apply('glance', { temporary: true });
  console.log('[gabriele] completion peek');
  completionPeekTimer = setTimeout(() => {
    completionPeekTimer = null;
    if (state === 'glance') apply('hidden', { temporary: true });
  }, COMPLETION_PEEK_MS);
  if (completionPeekTimer.unref) completionPeekTimer.unref();
}

function createWindow() {
  win = new BrowserWindow({
    width: W, height: H,
    minWidth: 360, minHeight: 280,
    show: false,
    frame: false, transparent: true, resizable: true, movable: true,
    skipTaskbar: true, hasShadow: false, fullscreenable: false,
    alwaysOnTop: true, focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });

  placeWindow();
  pinToGameLayer();
  win.loadFile(path.join(__dirname, 'index.html'), { hash: encodeURIComponent(JSON.stringify({ url: WS_URL, token: TOKEN })) });
  win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[renderer]', msg));
  win.webContents.once('did-finish-load', () => apply('glance'));
  win.on('show', pinToGameLayer);
  win.on('restore', pinToGameLayer);
  win.on('blur', () => setTimeout(reassertGameVisibility, 50));
}

function startDevReload() {
  if (!DEV_RELOAD) return;

  const files = [
    { file: path.join(__dirname, 'styles.css'), type: 'css' },
    { file: path.join(__dirname, 'index.html'), type: 'window' },
    { file: path.join(__dirname, 'renderer.js'), type: 'window' },
    { file: path.join(__dirname, 'preload.js'), type: 'window' },
  ];
  const changed = new Set();

  function schedule(file, type) {
    let mtime = Date.now();
    try { mtime = fs.statSync(file).mtimeMs; } catch {}
    if (devReloadMtimes.get(file) === mtime) return;
    devReloadMtimes.set(file, mtime);

    changed.add(type);
    clearTimeout(devReloadTimer);
    devReloadTimer = setTimeout(() => {
      const types = new Set(changed);
      changed.clear();
      reloadForDev(file, types);
    }, 120);
  }

  for (const { file, type } of files) {
    try {
      const watcher = fs.watch(file, { persistent: false }, () => schedule(file, type));
      devWatchers.push(watcher);
    } catch (err) {
      console.warn(`[gabriele] dev reload could not watch ${path.basename(file)}: ${err.message}`);
    }
  }

  console.log('[gabriele] dev reload watching overlay renderer files');
}

function reloadForDev(file, types) {
  if (!win || win.isDestroyed()) return;

  if (types.size === 1 && types.has('css')) {
    console.log(`[gabriele] dev reload css: ${path.basename(file)}`);
    win.webContents.send('dev-reload-css');
    return;
  }

  const nextState = state;
  console.log(`[gabriele] dev reload window: ${path.basename(file)}`);
  win.webContents.once('did-finish-load', () => {
    apply(nextState);
    reassertGameVisibility();
  });
  win.webContents.reloadIgnoringCache();
}

// hidden = not shown · glance = visible + click-through · focused = visible + typing
function apply(next, opts = {}) {
  if (!opts.temporary) cancelCompletionPeek();
  const prev = state;
  if (next === 'focused' && prev !== 'focused') rememberMacActiveApp();
  state = next;
  if (next === 'hidden') {
    win.hide();
    if (process.platform === 'darwin') app.hide();
  } else {
    if (next === 'glance') win.showInactive(); else win.show();
    pinToGameLayer();
    if (next === 'glance') {
      win.setIgnoreMouseEvents(true, { forward: true });
      win.webContents.send('focus', false);
    } else { // focused
      win.setIgnoreMouseEvents(false);
      win.focus();
      if (process.platform === 'darwin') app.focus({ steal: true });
      win.webContents.send('focus', true);
    }
  }
  if (prev === 'focused' && next !== 'focused') restoreMacActiveApp();
  updateTray();
}

const toggleSummon = () => apply(state === 'focused' ? 'hidden' : 'focused'); // hidden/glance→type, focused→hide
const toggleGlance = () => apply(state === 'glance' ? 'hidden' : 'glance');

function updateTray() {
  if (!tray) return;
  tray.setTitle(' Gabriele');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `state: ${state}`, enabled: false },
    { type: 'separator' },
    { label: state === 'focused' ? 'Hide   ⌥⇧Tab' : 'Select prompt   ⌥⇧Tab', click: toggleSummon },
    { label: state === 'glance' ? 'Stop glancing   ⌥⇧G' : 'Glance   ⌥⇧G', click: toggleGlance },
    { type: 'separator' },
    { label: 'Quit Gabriele', click: () => app.quit() },
  ]));
}

app.whenReady().then(() => {
  createWindow();
  startVisibilityPulse();
  startDevReload();

  screen.on('display-added', () => { placeWindow(); reassertGameVisibility(); });
  screen.on('display-removed', () => { placeWindow(); reassertGameVisibility(); });
  screen.on('display-metrics-changed', () => { placeWindow(); reassertGameVisibility(); });

  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Gabriele — agent overlay');
  updateTray();

  const a = globalShortcut.register(HOTKEY, toggleSummon);
  const b = globalShortcut.register(GLANCE_HOTKEY, toggleGlance);
  console.log(`[gabriele] overlay ready. bridge=${WS_URL} summon=${HOTKEY}(${a}) glance=${GLANCE_HOTKEY}(${b})`);

  // macOS: global hotkeys can register yet not fire while another app is frontmost
  // unless the app is trusted for Accessibility. Check, and prompt once if not.
  if (process.platform === 'darwin') {
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    console.log(`[gabriele] accessibility trusted: ${trusted}`);
    if (!trusted) {
      console.log('[gabriele] -> hotkeys may not fire while gaming; opening the Accessibility grant prompt');
      systemPreferences.isTrustedAccessibilityClient(true); // shows the System Settings prompt
    }
  }

  ipcMain.on('exit-focus', () => apply('glance'));

  // In glance the window is click-through; the renderer flips this off while the
  // cursor is over interactive chrome (rail/header) so chips, ×, +, and drag work
  // without summoning. No-op in focused (already interactive) / hidden.
  ipcMain.on('interactive', (_e, on) => {
    if (state === 'glance') win.setIgnoreMouseEvents(!on, { forward: true });
  });

  ipcMain.handle('open-external', async (_e, rawUrl) => {
    try {
      const url = new URL(String(rawUrl || ''));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      await shell.openExternal(url.href);
      return true;
    } catch (err) {
      console.warn(`[gabriele] refused external link: ${err.message}`);
      return false;
    }
  });

  // Native notification when a claude session finishes a turn (renderer decides
  // when). Suppressed while focused — you're already looking. Click → summon to
  // that session.
  ipcMain.on('notify', (_e, { title, body, id }) => {
    showCompletionPeek();
    if (state === 'focused' || !Notification.isSupported()) return;
    console.log(`[gabriele] notify: ${title} — ${body}`);
    const n = new Notification({ title: title || 'Gabriele', body: body || '', silent: false });
    n.on('click', () => { apply('focused'); if (id) win.webContents.send('focus-session', id); });
    n.show();
  });

  // Debug-only: capture the window itself (no screen-recording grant needed).
  if (process.env.GABRIELE_SHOT) {
    const out = process.env.GABRIELE_SHOT_PATH || '/tmp/gabriele_hud.png';
    setInterval(async () => {
      try { const img = await win.webContents.capturePage(); fs.writeFileSync(out, img.toPNG()); } catch {}
    }, 1500);
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {}); // tray app: stay alive when the window is hidden
