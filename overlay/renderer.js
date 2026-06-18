const { wsUrl, onFocus } = window.gabriele;

const railEl = document.getElementById('rail');
const connEl = document.getElementById('conn');
const edgeEl = document.getElementById('edge');

const sessions = new Map(); // id -> meta
let focusedId = null;
let ws;

// ---- terminal ----
const term = new Terminal({
  fontFamily: 'Menlo, Monaco, "SF Mono", ui-monospace, monospace',
  fontSize: 12,
  cursorBlink: true,
  allowTransparency: true,
  theme: {
    background: 'rgba(0,0,0,0)',
    foreground: '#e7ebf2',
    cursor: '#4aa3ff',
    selectionBackground: 'rgba(74,163,255,0.3)',
  },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
setTimeout(() => sendResize(), 0);

term.onData((d) => {
  if (focusedId) ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'input', id: focusedId, data: d }));
});

function sendResize() {
  try { fit.fit(); } catch {}
  if (focusedId && ws?.readyState === 1)
    ws.send(JSON.stringify({ type: 'resize', id: focusedId, cols: term.cols, rows: term.rows }));
}
window.addEventListener('resize', sendResize);

// ---- websocket ----
function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connect, 1200); };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}

function handle(msg) {
  switch (msg.type) {
    case 'sessions':
      sessions.clear();
      for (const m of msg.sessions) sessions.set(m.id, m);
      renderRail();
      if (sessions.size === 0) ws.send(JSON.stringify({ type: 'new' }));       // bootstrap one
      else if (!focusedId) focus([...sessions.keys()][0]);
      break;
    case 'session': {
      const prev = sessions.get(msg.meta.id);
      sessions.set(msg.meta.id, msg.meta);
      renderRail();
      if (!focusedId) focus(msg.meta.id);
      if (prev && prev.state !== msg.meta.state && (msg.meta.state === 'idle' || msg.meta.state === 'exited'))
        flashEdge();
      break;
    }
    case 'data':
      if (msg.id === focusedId) term.write(msg.data);
      break;
    case 'snapshot':
      if (msg.id === focusedId) { term.reset(); term.write(msg.data); }
      break;
  }
}

function focus(id) {
  focusedId = id;
  term.reset();
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'focus', id })); // replay scrollback
  sendResize();
  renderRail();
}

function setConn(on) {
  connEl.textContent = on ? 'live' : 'offline';
  connEl.classList.toggle('off', !on);
}

function flashEdge() {
  edgeEl.classList.remove('flash');
  void edgeEl.offsetWidth;
  edgeEl.classList.add('flash');
}

function renderRail() {
  railEl.innerHTML = '';
  const list = [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const s of list) {
    const chip = document.createElement('button');
    chip.className = `chip ${s.state}` + (s.id === focusedId ? ' active' : '');
    chip.innerHTML = `<span class="dot"></span><span class="ctitle">${esc(s.title)}</span>`;
    chip.onclick = () => focus(s.id);
    railEl.appendChild(chip);
  }
  const add = document.createElement('button');
  add.className = 'chip add';
  add.textContent = '+';
  add.title = 'new session';
  add.onclick = () => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'new' }));
  railEl.appendChild(add);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- focus mode (global hotkey via main) ----
onFocus((on) => {
  document.body.classList.toggle('focused', on);
  if (on) { term.focus(); sendResize(); } else { term.blur(); }
});

connect();
