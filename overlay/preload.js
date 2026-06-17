const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gabriele', {
  wsUrl: decodeURIComponent((location.hash || '').slice(1)) || 'ws://127.0.0.1:4848',
  onFocus: (cb) => ipcRenderer.on('focus', (_e, on) => cb(on)),
  exitFocus: () => ipcRenderer.send('exit-focus'),
});
