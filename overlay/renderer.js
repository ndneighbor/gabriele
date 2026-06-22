const { wsUrl, token, onFocus, clipboard, notify, onFocusSession } = window.gabriele;
const RELAY = !!token; // token set => connect via the relay: send hello, wait for hello_ok

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
let ready = false; // true once it's safe to send app messages (after auth in relay mode)
const scrollPos = new Map(); // id -> scroll offset from bottom (spatial continuity)
let lastClosed = null;       // {cmd, cwd, profile} of the most recently closed channel (⌘⇧T reopen)
let profiles = [];           // [{id,label}] logins advertised by the relay/bridge
let defaultProfile = null;

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
  if (focusedId) wsSend({ type: 'input', id: focusedId, data: d });
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
    if (t && focusedId) wsSend({ type: 'input', id: focusedId, data: t });
    return false;
  }
  if (e.key === 'w') { if (focusedId) closeSession(focusedId); return false; } // ⌘W close pane
  if (e.shiftKey && e.key.toLowerCase() === 't') { reopenLast(); return false; } // ⌘⇧T reopen last closed
  if (e.key === 't') { newChannel(); return false; }                          // ⌘T new pane (profile picker if >1 login)
  if (e.code === 'BracketLeft')  { cycleFocus(-1); return false; }             // ⌘[ previous tab
  if (e.code === 'BracketRight') { cycleFocus(1); return false; }             // ⌘] next tab
  if (e.key >= '1' && e.key <= '9') { focusByIndex(+e.key - 1); return false; } // ⌘1-9 jump to tab
  return true;
});

function wsSend(obj) {
  if (ready && ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function sendResize() {
  try { fit.fit(); } catch {}
  if (focusedId) wsSend({ type: 'resize', id: focusedId, cols: term.cols, rows: term.rows });
}
window.addEventListener('resize', sendResize);

function newSession(profile) {
  wsSend({ type: 'new', cols: term.cols, rows: term.rows, profile: profile || defaultProfile });
}

// ⌘T / + : pick which login the new channel runs under (only when >1 exists)
function newChannel() {
  if (profiles.length <= 1) { newSession(defaultProfile); return; }
  closePicker();
  const pop = document.createElement('div');
  pop.id = 'picker';
  pop.innerHTML = '<div class="pk-h">NEW CHANNEL · PROFILE</div>' +
    profiles.map((p) => `<button class="pk-row" data-id="${esc(p.id)}"><span>${esc(p.label)}</span>${p.id === defaultProfile ? '<em>DEFAULT</em>' : ''}</button>`).join('');
  document.body.appendChild(pop);
  const addBtn = railEl.querySelector('.chip.add');
  if (addBtn) { const r = addBtn.getBoundingClientRect(); pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 216)) + 'px'; pop.style.top = (r.bottom + 6) + 'px'; }
  pop.querySelectorAll('.pk-row').forEach((b) => (b.onclick = () => { newSession(b.dataset.id); closePicker(); }));
  pop.addEventListener('mouseenter', () => window.gabriele.setInteractive(true));   // clickable in glance
  pop.addEventListener('mouseleave', () => window.gabriele.setInteractive(false));
  setTimeout(() => document.addEventListener('mousedown', onPickerOutside), 0);
}
function onPickerOutside(e) { const p = document.getElementById('picker'); if (p && !p.contains(e.target)) closePicker(); }
function closePicker() { const p = document.getElementById('picker'); if (p) p.remove(); document.removeEventListener('mousedown', onPickerOutside); }

function closeSession(id) {
  const s = sessions.get(id);
  if (s) lastClosed = { cmd: s.cmd, cwd: s.cwd, profile: s.profile };   // remember for ⌘⇧T reopen
  wsSend({ type: 'close', id });
}

function reopenLast() {
  if (!lastClosed) return;
  // claude resumes the last conversation in that cwd via --continue (transcript persists)
  const args = /claude/.test(lastClosed.cmd || '') ? ['--continue'] : [];
  wsSend({ type: 'new', cmd: lastClosed.cmd, cwd: lastClosed.cwd, args, profile: lastClosed.profile, cols: term.cols, rows: term.rows });
  lastClosed = null;
}

// ---- websocket ----
function connect() {
  ready = false;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    if (RELAY) ws.send(JSON.stringify({ type: 'hello', role: 'client', token })); // auth, then wait for hello_ok
    else onReady(true);                                                            // direct LAN bridge: live now
  };
  ws.onclose = () => { ready = false; setConn(false); setTimeout(connect, 1200); };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}

function onReady(hostPresent) {
  ready = true;
  setConn(hostPresent);     // direct: connected · relay: only if the Mac bridge is live
  wsSend({ type: 'sync' });  // pull the current session list
}

function handle(msg) {
  switch (msg.type) {
    case 'hello_ok':                       // relay accepted us
      onReady(msg.host_present !== false);
      break;
    case 'host_up':                        // the Mac bridge (re)connected to the relay
      setConn(true);
      wsSend({ type: 'sync' });
      break;
    case 'host_down':                      // the Mac bridge dropped off the relay
      setConn(false);
      break;
    case 'sessions':
      if (msg.profiles) { profiles = msg.profiles; defaultProfile = msg.defaultProfile || (profiles[0] && profiles[0].id) || null; }
      sessions.clear();
      for (const m of msg.sessions) sessions.set(m.id, m);
      renderRail();
      if (sessions.size && !focusedId) focus([...sessions.keys()][0]);          // no auto-bootstrap (use + / ⌘T) — auto-new caused phantom storms
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
      if (msg.id === focusedId) {
        term.reset();
        const off = scrollPos.get(msg.id) || 0;
        term.write(msg.data, () => {           // restore scroll once the replay is rendered
          if (off > 0) { try { term.scrollToLine(Math.max(0, term.buffer.active.baseY - off)); } catch {} }
        });
      }
      break;
    case 'closed':
      sessions.delete(msg.id);
      settled.delete(msg.id);
      lastNotify.delete(msg.id);
      scrollPos.delete(msg.id);
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
  if (focusedId && focusedId !== id) scrollPos.set(focusedId, scrollOffset()); // remember where we were
  focusedId = id;
  term.reset();
  wsSend({ type: 'focus', id }); // replay scrollback
  sendResize();
  renderRail();
}
function scrollOffset() {
  try { const b = term.buffer.active; return Math.max(0, b.baseY - b.viewportY); } catch { return 0; }
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

function orderedSessions() {
  return [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
}
function focusByIndex(i) {
  const list = orderedSessions();
  if (list[i]) focus(list[i].id);
}
function cycleFocus(dir) {
  const list = orderedSessions();
  if (list.length < 2) return;
  const idx = list.findIndex((s) => s.id === focusedId);
  const next = list[(Math.max(0, idx) + dir + list.length) % list.length];
  if (next) focus(next.id);
}

function renderRail() {
  railEl.innerHTML = '';
  orderedSessions().forEach((s, i) => {
    const chip = document.createElement('button');
    chip.className = `chip ${s.state}` + (s.id === focusedId ? ' active' : '');
    const label = (s.cmd || s.title || '').split('/').pop().split(' ')[0] || 'sh';
    const prof = (profiles.length > 1 && s.profile) ? `<span class="cprof">${esc(String(s.profile).toUpperCase())}</span>` : '';
    chip.innerHTML = `<span class="dot"></span><span class="ch">CH-${i + 1}</span><span class="ctitle">${esc(label)}</span>${prof}<span class="x" title="close (⌘W)">×</span>`;
    chip.onclick = () => focus(s.id);
    chip.querySelector('.x').onclick = (e) => { e.stopPropagation(); closeSession(s.id); };
    railEl.appendChild(chip);
  });
  renderStatus();
  const add = document.createElement('button');
  add.className = 'chip add';
  add.textContent = '+';
  add.title = 'new session';
  add.onclick = () => newChannel();
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

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });

connect();
