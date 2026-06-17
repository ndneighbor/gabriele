// Gabriele overlay — runs on the gaming PC (or locally for testing).
// A transparent, always-on-top, click-through window that floats over the
// game. It NEVER injects into the game process: it is just a separate top-most
// window the OS composites on top. A global hotkey flips it from passive
// (click-through) to focus mode so you can type a prompt, then back.

const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// Where the bridge lives. Local test: 127.0.0.1. On the gaming PC, set
// GABRIELE_URL=ws://<mac-lan-ip>:4848 (your Mac is 172.20.6.188).
const WS_URL = process.env.GABRIELE_URL || 'ws://127.0.0.1:4848';
const HOTKEY = process.env.GABRIELE_HOTKEY || 'Alt+Shift+Tab';

let win;
let focusMode = false;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 380, H = 540, margin = 24;

  win = new BrowserWindow({
    width: W,
    height: H,
    x: workArea.x + workArea.width - W - margin,
    y: workArea.y + workArea.height - H - margin,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    alwaysOnTop: true,
    focusable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });

  // Float above borderless fullscreen games, and follow across spaces (mac).
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  setPassive();

  win.loadFile(path.join(__dirname, 'index.html'), { hash: encodeURIComponent(WS_URL) });
}

function setPassive() {
  focusMode = false;
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.send('focus', false);
}

function setFocus() {
  focusMode = true;
  win.setIgnoreMouseEvents(false);
  win.show();
  win.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.webContents.send('focus', true);
}

function toggleFocus() {
  focusMode ? setPassive() : setFocus();
}

app.whenReady().then(() => {
  createWindow();
  const ok = globalShortcut.register(HOTKEY, toggleFocus);
  console.log(`[gabriele] overlay ready. bridge=${WS_URL} hotkey=${HOTKEY} registered=${ok}`);

  // Renderer asks to drop back to passive (Esc, or after submitting a prompt).
  ipcMain.on('exit-focus', setPassive);

  // Debug-only: periodically capture the window itself (no screen-recording
  // permission needed) so the HUD render can be verified. Set GABRIELE_SHOT=1.
  if (process.env.GABRIELE_SHOT) {
    const out = process.env.GABRIELE_SHOT_PATH || '/tmp/gabriele_hud.png';
    setInterval(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(out, img.toPNG());
      } catch {}
    }, 1500);
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
