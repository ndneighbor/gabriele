const { wsUrl, onFocus, clipboard, notify, onFocusSession } = window.gabriele;

const railEl = document.getElementById('rail');
const connEl = document.getElementById('conn');
const edgeEl = document.getElementById('edge');

const sessions = new Map(); // id -> meta
const settled = new Set();   // session ids that idled once already (skip startup render)
const lastNotify = new Map(); // id -> last notify time (de-dupe mid-turn idle flaps)
let focusedId = null;
let ws;

// ---- terminal ----
const term = new Terminal({
  fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Monaco, ui-monospace, monospace',
  fontSize: 13,
  lineHeight: 1.15,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 8000,
  allowTransparency: true,
  theme: {
    background: 'rgba(0,0,0,0)',
    foreground: '#e7ebf2',
    cursor: '#4aa3ff',
    cursorAccent: '#0e1016',
    selectionBackground: 'rgba(74,163,255,0.30)',
    black: '#2a2f3a', red: '#ff6b6b', green: '#3ddc84', yellow: '#ffc24a',
    blue: '#5aa9ff', magenta: '#c792ea', cyan: '#56d4dd', white: '#c9d1e0',
    brightBlack: '#5a6273', brightRed: '#ff8585', brightGreen: '#6ef0a6',
    brightYellow: '#ffd479', brightBlue: '#82bdff', brightMagenta: '#e0b0ff',
    brightCyan: '#7fe9f0', brightWhite: '#eef2f8',
  },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
setTimeout(() => sendResize(), 0);
new ResizeObserver(() => sendResize()).observe(document.getElementById('term'));

term.onData((d) => {
  if (focusedId) ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'input', id: focusedId, data: d }));
});

// clipboard: copy-on-select (iTerm-style) + ⌘C / ⌘V
term.onSelectionChange(() => {
  const sel = term.getSelection();
  if (sel) clipboard.write(sel);
});
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown' || !e.metaKey) return true;
  if (e.key === 'c' && term.hasSelection()) { clipboard.write(term.getSelection()); return false; }
  if (e.key === 'v') {
    const t = clipboard.read();
    if (t && focusedId && ws?.readyState === 1) ws.send(JSON.stringify({ type: 'input', id: focusedId, data: t }));
    return false;
  }
  return true;
});

function sendResize() {
  try { fit.fit(); } catch {}
  if (focusedId && ws?.readyState === 1)
    ws.send(JSON.stringify({ type: 'resize', id: focusedId, cols: term.cols, rows: term.rows }));
}
window.addEventListener('resize', sendResize);

function newSession() {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'new', cols: term.cols, rows: term.rows }));
}

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
      if (sessions.size === 0) newSession();                                   // bootstrap one
      else if (!focusedId) focus([...sessions.keys()][0]);
      break;
    case 'session': {
      const prev = sessions.get(msg.meta.id);
      const m = msg.meta, was = prev?.state;
      sessions.set(m.id, m);
      renderRail();
      if (!focusedId) focus(m.id);
      if (was && was !== m.state && (m.state === 'idle' || m.state === 'exited')) flashEdge();
      // "claude responded": a claude session finishes a turn (running -> idle).
      // Skip its very first idle — that's the startup render, not a response.
      if (was === 'running' && /claude/.test(m.cmd || '')) {
        if (m.state === 'exited') fire('Session ended', m);
        else if (m.state === 'idle') {
          if (settled.has(m.id)) fire('Claude responded', m);
          else settled.add(m.id);
        }
      }
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
  add.onclick = () => newSession();
  railEl.appendChild(add);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const NOTIFY_COOLDOWN_MS = 10000;
function fire(title, m) {
  const now = Date.now();
  if (now - (lastNotify.get(m.id) || 0) < NOTIFY_COOLDOWN_MS) return; // collapse mid-turn idle flaps
  lastNotify.set(m.id, now);
  notify({ title, body: m.title, id: m.id });
}

// ---- focus mode (global hotkey via main) ----
onFocus((on) => {
  document.body.classList.toggle('focused', on);
  if (on) { term.focus(); sendResize(); } else { term.blur(); }
});

// notification click → main summons us, we jump to that session
onFocusSession((id) => { if (sessions.has(id)) focus(id); });

connect();
