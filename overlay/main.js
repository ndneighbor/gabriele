// Gabriele overlay — runs on the gaming PC (or locally for testing).
// A transparent, always-on-top, click-through window that floats over the game.
// It NEVER injects into the game process: it's a separate top-most window the OS
// composites on top. Three visibility states: hidden / glance / focused.

const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, Notification, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('Gabriele');

// Bridge location. Local test: 127.0.0.1. On the gaming PC, set
// GABRIELE_URL=ws://<mac-lan-ip>:4848 (your Mac is 172.20.6.188).
const WS_URL = process.env.GABRIELE_URL || 'ws://127.0.0.1:4848';
const HOTKEY = process.env.GABRIELE_HOTKEY || 'Alt+Shift+Tab';            // summon(type) / hide
const GLANCE_HOTKEY = process.env.GABRIELE_GLANCE_HOTKEY || 'Alt+Shift+G'; // glance / hide

let win, tray;
let state = 'glance'; // 'hidden' | 'glance' | 'focused'

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 600, H = 640, margin = 24;

  win = new BrowserWindow({
    width: W, height: H,
    x: workArea.x + workArea.width - W - margin,
    y: workArea.y + workArea.height - H - margin,
    minWidth: 360, minHeight: 280,
    show: false,
    frame: false, transparent: true, resizable: true, movable: true,
    skipTaskbar: true, hasShadow: false, fullscreenable: false,
    alwaysOnTop: true, focusable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'index.html'), { hash: encodeURIComponent(WS_URL) });
  win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[renderer]', msg));
  win.webContents.once('did-finish-load', () => apply('glance'));
}

// hidden = not shown · glance = visible + click-through · focused = visible + typing
function apply(next) {
  state = next;
  if (next === 'hidden') {
    win.hide();
  } else {
    if (next === 'glance') win.showInactive(); else win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
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
  updateTray();
}

const toggleSummon = () => apply(state === 'hidden' ? 'focused' : 'hidden'); // visible→hide, hidden→type
const toggleGlance = () => apply(state === 'glance' ? 'hidden' : 'glance');

function updateTray() {
  if (!tray) return;
  tray.setTitle(' Gabriele');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `state: ${state}`, enabled: false },
    { type: 'separator' },
    { label: state === 'hidden' ? 'Show & type   ⌥⇧Tab' : 'Hide   ⌥⇧Tab', click: toggleSummon },
    { label: state === 'glance' ? 'Stop glancing   ⌥⇧G' : 'Glance   ⌥⇧G', click: toggleGlance },
    { type: 'separator' },
    { label: 'Quit Gabriele', click: () => app.quit() },
  ]));
}

app.whenReady().then(() => {
  createWindow();

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

  // Native notification when a claude session finishes a turn (renderer decides
  // when). Suppressed while focused — you're already looking. Click → summon to
  // that session.
  ipcMain.on('notify', (_e, { title, body, id }) => {
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
