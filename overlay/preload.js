const { contextBridge, ipcRenderer, clipboard } = require('electron');

// main passes {url, token} via the location hash (JSON). token set => relay/auth mode.
const cfg = (() => { try { return JSON.parse(decodeURIComponent((location.hash || '').slice(1))); } catch { return {}; } })();

contextBridge.exposeInMainWorld('gabriele', {
  wsUrl: cfg.url || 'ws://127.0.0.1:4848',
  token: cfg.token || '',
  onFocus: (cb) => ipcRenderer.on('focus', (_e, on) => cb(on)),
  exitFocus: () => ipcRenderer.send('exit-focus'),
  clipboard: {
    write: (t) => clipboard.writeText(t),
    read: () => clipboard.readText(),
  },
  notify: (payload) => ipcRenderer.send('notify', payload),
  onFocusSession: (cb) => ipcRenderer.on('focus-session', (_e, id) => cb(id)),
  setInteractive: (on) => ipcRenderer.send('interactive', on),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onDevReloadCss: (cb) => ipcRenderer.on('dev-reload-css', () => cb()),
});
