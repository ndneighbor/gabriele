const { wsUrl, onFocus, exitFocus } = window.gabriele;

const tilesEl = document.getElementById('tiles');
const connEl = document.getElementById('conn');
const inputbar = document.getElementById('inputbar');
const promptEl = document.getElementById('prompt');
const edgeEl = document.getElementById('edge');

const agents = new Map();   // id -> agent
const prevState = new Map(); // id -> last rendered state
let ws;

function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connect, 1200); };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'agents') {
      agents.clear();
      for (const a of msg.agents) agents.set(a.id, a);
    } else if (msg.type === 'agent_update') {
      agents.set(msg.agent.id, msg.agent);
    }
    render();
  };
}

function setConn(on) {
  connEl.textContent = on ? 'live' : 'offline';
  connEl.classList.toggle('off', !on);
}

function send(text) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'prompt', text }));
}

function flashEdge() {
  edgeEl.classList.remove('flash');
  void edgeEl.offsetWidth; // restart animation
  edgeEl.classList.add('flash');
}

const DONE = new Set(['done', 'error', 'blocked']);

function render() {
  // newest first
  const list = [...agents.values()].sort((a, b) => b.startedAt - a.startedAt);
  tilesEl.innerHTML = '';
  for (const a of list) {
    const prev = prevState.get(a.id);
    const justSettled = prev && prev !== a.state && DONE.has(a.state);
    prevState.set(a.id, a.state);

    const tile = document.createElement('div');
    tile.className = `tile ${a.state}` + (justSettled ? ' settled' : '');
    tile.innerHTML = `
      <span class="dot"></span>
      <div class="body">
        <div class="title">${esc(a.title)}</div>
        <div class="last">${esc(a.lastLine || statusWord(a.state))}</div>
      </div>
      <span class="state">${statusWord(a.state)}</span>`;
    tilesEl.appendChild(tile);

    if (justSettled) flashEdge();
  }
  if (list.length === 0) {
    tilesEl.innerHTML = `<div class="empty">no agents yet — ⌥⇧Tab to dispatch one</div>`;
  }
}

function statusWord(s) {
  return { running: 'running', done: 'done', error: 'error', blocked: 'blocked' }[s] || s;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- focus mode (driven by the global hotkey via main) ----
onFocus((on) => {
  inputbar.classList.toggle('hidden', !on);
  document.body.classList.toggle('focused', on);
  if (on) { promptEl.value = ''; promptEl.focus(); }
});

promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && promptEl.value.trim()) {
    send(promptEl.value.trim());
    promptEl.value = '';
    exitFocus();
  } else if (e.key === 'Escape') {
    exitFocus();
  }
});

connect();
