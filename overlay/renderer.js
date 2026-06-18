const { wsUrl, onFocus, clipboard, notify, onFocusSession } = window.gabriele;

const railEl = document.getElementById('rail');
const statusEl = document.getElementById('status');
const connEl = document.getElementById('conn');
const edgeEl = document.getElementById('edge');

const sessions = new Map(); // id -> meta
const settled = new Set();   // session ids that idled once already (skip startup render)
const lastNotify = new Map(); // id -> last notify time (de-dupe mid-turn idle flaps)
let focusedId = null;
let ws;
let connected = false;

// ---- terminal ----
const term = new Terminal({
  fontFamily: '"Martian Mono", "SF Mono", ui-monospace, monospace',
  fontSize: 12,
  lineHeight: 1.2,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 8000,
  allowTransparency: true,
  theme: {
    background: 'rgba(0,0,0,0)',
    foreground: '#d6d6da',
    cursor: '#c2ec3a',
    cursorAccent: '#0d0f08',
    selectionBackground: 'rgba(194,236,58,0.25)',
    black: '#16161a', red: '#e8483e', green: '#c2ec3a', yellow: '#e0c454',
    blue: '#5aa9ff', magenta: '#c98cff', cyan: '#46c8dc', white: '#d6d6da',
    brightBlack: '#54545c', brightRed: '#ff5247', brightGreen: '#d4f060',
    brightYellow: '#ffd479', brightBlue: '#82bdff', brightMagenta: '#dcaeff',
    brightCyan: '#74e0f0', brightWhite: '#ffffff',
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
  if (e.key === 'w') { if (focusedId) closeSession(focusedId); return false; } // ⌘W close pane
  if (e.key === 't') { newSession(); return false; }                          // ⌘T new pane
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

function closeSession(id) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'close', id }));
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
    case 'closed':
      sessions.delete(msg.id);
      settled.delete(msg.id);
      lastNotify.delete(msg.id);
      if (focusedId === msg.id) {
        focusedId = null;
        const next = [...sessions.keys()][0];
        if (next) focus(next);
        else term.reset();          // none left — blank pane, '+' to spawn a new one
      }
      renderRail();
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
  connected = on;
  document.body.classList.toggle('offline', !on);
  renderStatus();
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
    const label = (s.cmd || s.title || '').split('/').pop().split(' ')[0] || 'sh';
    chip.innerHTML = `<span class="dot"></span><span class="ch">CH-${esc(s.id)}</span><span class="ctitle">${esc(label)}</span><span class="x" title="close (⌘W)">×</span>`;
    chip.onclick = () => focus(s.id);
    chip.querySelector('.x').onclick = (e) => { e.stopPropagation(); closeSession(s.id); };
    railEl.appendChild(chip);
  }
  renderStatus();
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

function renderStatus() {
  if (!statusEl) return;
  if (!connected) { statusEl.innerHTML = '<b class="s-err">◇ BRIDGE OFFLINE</b>'; return; }
  const c = { running: 0, idle: 0, error: 0 };
  for (const s of sessions.values()) if (c[s.state] != null) c[s.state]++;
  const parts = [];
  if (c.running) parts.push(`<b class="s-run">${c.running} RUN</b>`);
  if (c.idle) parts.push(`<b class="s-idle">${c.idle} IDLE</b>`);
  if (c.error) parts.push(`<b class="s-err">${c.error} ERR</b>`);
  statusEl.innerHTML = parts.join('&nbsp;·&nbsp;') || 'NO CHANNELS';
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

// In glance the window is click-through; make the chrome (rail + header)
// clickable while hovered so you can close/switch panes without summoning.
// (Mouse-move is forwarded in glance, so these fire even when click-through.)
for (const el of [railEl, document.getElementById('bar')]) {
  el.addEventListener('mouseenter', () => window.gabriele.setInteractive(true));
  el.addEventListener('mouseleave', () => window.gabriele.setInteractive(false));
}

connect();
