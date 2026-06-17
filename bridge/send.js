// Tiny CLI to fire a prompt at the bridge — used for testing the loop
// without the overlay UI.  Usage: node bridge/send.js "your prompt here"
const WebSocket = require('ws');
const url = process.env.DURANDAL_URL || 'ws://127.0.0.1:4848';
const text = process.argv.slice(2).join(' ') || 'Say hi from Durandal in one short sentence.';
const ws = new WebSocket(url);
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'prompt', text }));
  console.log(`[send] -> ${url}: ${text}`);
  setTimeout(() => ws.close(), 300);
});
ws.on('error', (e) => { console.error('[send] error', e.message); process.exit(1); });
