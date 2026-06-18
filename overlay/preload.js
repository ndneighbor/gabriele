const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('gabriele', {
  wsUrl: decodeURIComponent((location.hash || '').slice(1)) || 'ws://127.0.0.1:4848',
  onFocus: (cb) => ipcRenderer.on('focus', (_e, on) => cb(on)),
  exitFocus: () => ipcRenderer.send('exit-focus'),
  clipboard: {
    write: (t) => clipboard.writeText(t),
    read: () => clipboard.readText(),
  },
  notify: (payload) => ipcRenderer.send('notify', payload),
  onFocusSession: (cb) => ipcRenderer.on('focus-session', (_e, id) => cb(id)),
  setInteractive: (on) => ipcRenderer.send('interactive', on),
});
