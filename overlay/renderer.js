const { wsUrl, token, onFocus, clipboard, notify, onFocusSession, openExternal } = window.gabriele;
const RELAY = !!token; // token set => connect via the relay: send hello, wait for hello_ok

const railEl = document.getElementById('rail');
const statusEl = document.getElementById('status');
const connEl = document.getElementById('conn');
const edgeEl = document.getElementById('edge');

const sessions = new Map(); // id -> meta
const lastNotify = new Map(); // id -> last notify time (de-dupe mid-turn idle flaps)
let focusedId = null;
let ws;
let connected = false;
let ready = false; // true once it's safe to send app messages (after auth in relay mode)
const scrollPos = new Map(); // id -> scroll offset from bottom (spatial continuity)
let lastClosed = null;       // {cmd, cwd, profile} of the most recently closed channel (⌘⇧T reopen)
let profiles = [];           // [{id,label}] logins advertised by the relay/bridge
let defaultProfile = null;
let wasDown = false;         // set on a real socket drop, so we repaint only on genuine reconnect (not every sessions frame)
const clientId = `desktop-${crypto.randomUUID()}`;
const clientKind = 'desktop';

// ---- terminal ----
const term = new Terminal({
  fontFamily: '"Martian Mono", "SF Mono", ui-monospace, monospace',
  fontSize: 12,
  lineHeight: 1.2,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 8000,
  allowTransparency: true,
  linkHandler: {
    activate: (_event, text) => openTerminalLink(text),
    hover: (event, text) => showLinkHover(event, text),
    leave: hideLinkHover,
    allowNonHttpProtocols: false,
  },
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
  if (ready && ws && ws.readyState === 1) ws.send(JSON.stringify({ clientId, clientKind, ...obj }));
}

function sendResize() {
  try { fit.fit(); } catch {}
  if (focusedId) wsSend({ type: 'resize', id: focusedId, cols: term.cols, rows: term.rows });
}
window.addEventListener('resize', sendResize);

const WEB_URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
let linkHoverEl = null;
function openTerminalLink(text) {
  const url = cleanUrl(text);
  if (!url) return;
  openExternal(url);
}

function cleanUrl(text) {
  let url = String(text || '').trim();
  if (!url) return null;

  while (/[.,;:!?}\]]$/.test(url)) url = url.slice(0, -1);
  while (url.endsWith(')') && countChar(url, '(') < countChar(url, ')')) url = url.slice(0, -1);

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function countChar(text, char) {
  let count = 0;
  for (const c of text) if (c === char) count++;
  return count;
}

function showLinkHover(event, text) {
  const url = cleanUrl(text);
  if (!url) return;

  const tip = ensureLinkHover();
  tip.textContent = url;
  tip.classList.add('show');

  const pad = 10;
  const x = Math.min(event.clientX + 12, window.innerWidth - tip.offsetWidth - pad);
  const y = Math.max(pad, event.clientY - tip.offsetHeight - 12);
  tip.style.left = `${Math.max(pad, x)}px`;
  tip.style.top = `${y}px`;
}

function hideLinkHover() {
  if (!linkHoverEl) return;
  linkHoverEl.classList.remove('show');
  linkHoverEl.removeAttribute('style');
}

function ensureLinkHover() {
  if (linkHoverEl) return linkHoverEl;
  linkHoverEl = document.createElement('div');
  linkHoverEl.id = 'link-tip';
  linkHoverEl.className = 'xterm-hover';
  document.body.appendChild(linkHoverEl);
  return linkHoverEl;
}

function registerWebLinkProvider() {
  if (typeof term.registerLinkProvider !== 'function') return;

  term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const wrapped = getWrappedText(bufferLineNumber);
      if (!wrapped) {
        callback(undefined);
        return;
      }

      const links = [];
      WEB_URL_RE.lastIndex = 0;

      for (let match = WEB_URL_RE.exec(wrapped.text); match; match = WEB_URL_RE.exec(wrapped.text)) {
        const url = cleanUrl(match[0]);
        if (!url) continue;

        const start = wrapped.cells[match.index];
        const end = wrapped.cells[match.index + url.length - 1];
        if (!start || !end) continue;

        links.push({
          text: url,
          range: {
            start,
            end,
          },
          decorations: { underline: true, pointerCursor: true },
          activate: (_event, text) => openTerminalLink(text),
          hover: (event, text) => showLinkHover(event, text),
          leave: hideLinkHover,
        });
      }

      callback(links.length ? links : undefined);
    },
  });
}
registerWebLinkProvider();

function getWrappedText(bufferLineNumber) {
  const buffer = term.buffer.active;
  let startY = bufferLineNumber - 1;
  let endY = startY;

  if (!buffer.getLine(startY)) return null;

  while (startY > 0 && buffer.getLine(startY)?.isWrapped) startY--;
  while (endY + 1 < buffer.length && buffer.getLine(endY + 1)?.isWrapped) endY++;

  let text = '';
  const cells = [];
  for (let y = startY; y <= endY; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const lineText = line.translateToString(y === endY);
    for (let x = 0; x < lineText.length; x++) {
      cells.push({ x: x + 1, y: y + 1 });
    }
    text += lineText;
  }

  return text ? { text, cells } : null;
}

if (window.gabriele.onDevReloadCss) {
  window.gabriele.onDevReloadCss(() => {
    const stamp = Date.now().toString();
    document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (!href.includes('styles.css')) return;
      link.setAttribute('href', `${href.split('?')[0]}?dev=${stamp}`);
    });
  });
}

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
  // Agent-specific resume is best-effort; unknown agents reopen fresh.
  const args = /claude/.test(lastClosed.cmd || '') ? ['--continue']
    : /codex/.test(lastClosed.cmd || '') ? ['resume', '--last']
      : [];
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
  ws.onclose = () => { ready = false; wasDown = true; clearInterval(keepalive); setConn(false); setTimeout(connect, 1200); };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}

let keepalive = null;
function onReady(hostPresent) {
  ready = true;
  setConn(hostPresent);     // direct: connected · relay: only if the Mac bridge is live
  wsSend({ type: 'client_hello' });
  wsSend({ type: 'sync' });  // pull the current session list
  clearInterval(keepalive);  // app-level heartbeat so the relay's idle reaper doesn't cull an idle overlay
  keepalive = setInterval(() => wsSend({ type: 'ping', t: Date.now() }), 25000);
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
      // Repaint ONLY after a genuine reconnect (wasDown), not on every sessions frame —
      // otherwise a flapping link (or just a routine backend resync) triggers a reset
      // storm mid-stream on the already-focused, already-correctly-rendering channel.
      if (focusedId && sessions.has(focusedId)) { if (wasDown) focus(focusedId); }
      else if (sessions.size) focus([...sessions.keys()][0]);                   // first connect — no auto-NEW (that caused phantom storms)
      wasDown = false;
      break;
    case 'session': {
      const prev = sessions.get(msg.meta.id);
      const m = msg.meta, was = prev?.state;
      sessions.set(m.id, m);
      renderRail();
      if (!focusedId) focus(m.id);
      if (was && was !== m.state && (m.state === 'idle' || m.state === 'exited')) flashEdge();
      // Agent session finishes a turn (running -> idle). Cooldown handles idle flaps.
      if (was === 'running') {
        if (m.state === 'exited') fire('Session ended', m);
        else if (m.state === 'idle') fire(agentDoneTitle(m), m);
      }
      break;
    }
    case 'turn_done': {
      const s = msg.id && sessions.get(msg.id);
      fire(msg.title || agentDoneTitle(s || msg), {
        id: msg.id,
        body: msg.body || s?.title || msg.cwd || '',
      });
      break;
    }
    case 'data':
      if (msg.id === focusedId) term.write(msg.data);
      break;
    case 'snapshot':
      if (msg.id === focusedId) {
        // write, not reset: the frame self-clears (ESC[2J/3J/H, bridge/server.js broadcastSnapshot).
        // A reset() here would wipe any 'data' that streamed in during the focus round-trip.
        const off = scrollPos.get(msg.id) || 0;
        term.write(msg.data, () => {           // restore scroll once the replay is rendered
          if (off > 0) { try { term.scrollToLine(Math.max(0, term.buffer.active.baseY - off)); } catch {} }
          else scrollActiveToBottom();
        });
      }
      break;
    case 'closed':
      sessions.delete(msg.id);
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

function scrollActiveToBottom() {
  if (focusedId) scrollPos.delete(focusedId);
  try { term.scrollToBottom(); return; } catch {}
  try { term.scrollToLine(term.buffer.active.baseY); } catch {}
}

function scrollActiveToBottomSoon() {
  scrollActiveToBottom();
  requestAnimationFrame(() => scrollActiveToBottom());
  setTimeout(() => scrollActiveToBottom(), 60);
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
  statusEl.innerHTML = parts.join('&nbsp;·&nbsp;') || (sessions.size ? `${sessions.size} CH` : 'NO CHANNELS');
}

const NOTIFY_COOLDOWN_MS = 2500;
const TOAST_MS = 2000;
let toastStackEl = null;
let audioCtx = null;

function agentDoneTitle(m) {
  return `${m?.kind === 'codex' ? 'Codex' : m?.kind || 'Agent'} completed`;
}

function fire(title, m = {}) {
  const now = Date.now();
  const body = m.body || m.title || '';
  const key = m.id || `${title}:${body}`;
  if (now - (lastNotify.get(key) || 0) < NOTIFY_COOLDOWN_MS) return; // collapse mid-turn idle flaps
  lastNotify.set(key, now);
  const payload = { title, body, id: m.id };
  flashEdge();
  showCompletionToast(payload);
  playNotifySound();
  notify(payload);
}

function ensureToastStack() {
  if (toastStackEl) return toastStackEl;
  toastStackEl = document.createElement('div');
  toastStackEl.id = 'toast-stack';
  document.body.appendChild(toastStackEl);
  return toastStackEl;
}

function showCompletionToast({ title, body, id }) {
  const stack = ensureToastStack();
  const toast = document.createElement('button');
  toast.type = 'button';
  toast.className = 'toast';
  toast.innerHTML = `<span class="tt">${esc(title)}</span>${body ? `<span class="tb">${esc(body)}</span>` : ''}`;
  toast.onclick = () => { if (id && sessions.has(id)) focus(id); };
  toast.addEventListener('mouseenter', () => window.gabriele.setInteractive(true));
  toast.addEventListener('mouseleave', () => window.gabriele.setInteractive(false));
  stack.prepend(toast);
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 180);
  }, TOAST_MS);
}

function playNotifySound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    audioCtx ||= new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const now = audioCtx.currentTime + 0.01;
    [740, 980].forEach((freq, i) => {
      const start = now + i * 0.08;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.045, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.13);
    });
  } catch {}
}

// ---- focus mode (global hotkey via main) ----
onFocus((on) => {
  document.body.classList.toggle('focused', on);
  if (on) { term.focus(); sendResize(); scrollActiveToBottomSoon(); } else { term.blur(); }
});

// notification click → main summons us, we jump to that session
onFocusSession((id) => {
  if (!sessions.has(id)) return;
  scrollPos.delete(id);
  focus(id);
  scrollActiveToBottomSoon();
});

// In glance the window is click-through; make the chrome (rail + header)
// clickable while hovered so you can close/switch panes without summoning.
// (Mouse-move is forwarded in glance, so these fire even when click-through.)
for (const el of [railEl, document.getElementById('bar')]) {
  el.addEventListener('mouseenter', () => window.gabriele.setInteractive(true));
  el.addEventListener('mouseleave', () => window.gabriele.setInteractive(false));
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });

connect();
