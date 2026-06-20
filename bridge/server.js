// Gabriele bridge — runs on the Mac. Hosts long-lived terminal sessions in real
// PTYs (node-pty) and streams their raw output to clients. Clients reach it two ways:
//   • directly over the LAN (ws server on :PORT), or
//   • through a relay it dials OUT to (host mode) — set GABRIELE_RELAY_URL.
// Both sinks share one broadcast path; inbound messages share one handler.

const pty = require('node-pty');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.GABRIELE_PORT || 4848);
const DEFAULT_CMD = process.env.GABRIELE_CMD || 'claude';
const DEFAULT_CWD = process.env.GABRIELE_CWD || process.cwd();
const SKIP_PERMS = process.env.GABRIELE_SKIP_PERMS !== '0'; // claude runs --dangerously-skip-permissions by default
const RELAY_URL = process.env.GABRIELE_RELAY_URL || '';     // if set, dial out to the relay as host
const TOKEN = process.env.GABRIELE_TOKEN || '';
const BUFFER_CAP = 200 * 1024; // per-session scrollback kept for replay
const IDLE_MS = 2000;          // no output this long => "idle" (turn done / awaiting you)

// id -> { id, title, cwd, cmd, state, startedAt, pty, buffer, idleTimer }
const sessions = new Map();
let nextId = 1;

let relay = null;        // ws client to the relay (host mode)
let relayAuthed = false;

const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT });
console.log(`[gabriele] bridge listening on ws://0.0.0.0:${PORT}`);

const meta = (s) => ({ id: s.id, title: s.title, cwd: s.cwd, cmd: s.cmd, state: s.state, startedAt: s.startedAt });
const sessionsSnapshot = () => ({ type: 'sessions', sessions: [...sessions.values()].map(meta) });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);          // local LAN clients
  if (relay && relayAuthed && relay.readyState === 1) relay.send(data);        // remote clients via relay
}
function setState(s, state) {
  if (!sessions.has(s.id)) return; // closed/removed — don't resurrect it
  if (s.state === state) return;
  s.state = state;
  broadcast({ type: 'session', meta: meta(s) });
}

function createSession({ cmd, args, cwd, title, cols, rows } = {}) {
  cmd = cmd || DEFAULT_CMD;
  cwd = cwd || DEFAULT_CWD;
  args = args || [];

  // fire-and-forget: claude sessions skip permission prompts (nobody's watching mid-game)
  if (SKIP_PERMS && /(^|\/)claude$/.test(cmd) && !args.includes('--dangerously-skip-permissions')) {
    args = ['--dangerously-skip-permissions', ...args];
  }

  const term = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: cols || 80, rows: rows || 24,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  const s = {
    id: String(nextId++),
    title: title || `${cmd.split('/').pop()} · ${cwd.split('/').pop()}`,
    cwd, cmd,
    state: 'running',
    startedAt: Date.now(),
    pty: term,
    buffer: '',
    idleTimer: null,
  };
  sessions.set(s.id, s);

  term.onData((data) => {
    if (!sessions.has(s.id)) return; // closed/removed — ignore late output
    s.buffer += data;
    if (s.buffer.length > BUFFER_CAP) s.buffer = s.buffer.slice(-BUFFER_CAP);
    broadcast({ type: 'data', id: s.id, data });
    setState(s, 'running');
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => setState(s, 'idle'), IDLE_MS);
  });

  term.onExit(({ exitCode }) => {
    if (!sessions.has(s.id)) return; // already closed/removed by the user
    clearTimeout(s.idleTimer);
    s.state = 'exited';
    broadcast({ type: 'exit', id: s.id, code: exitCode });
    broadcast({ type: 'session', meta: meta(s) });
  });

  broadcast({ type: 'session', meta: meta(s) });
  console.log(`[gabriele] session ${s.id}: ${cmd} @ ${cwd}`);
  return s;
}

// One inbound handler for both local clients and relay-forwarded clients.
// Replies broadcast (the relay can't target one remote client) — clients filter by id.
function handleMessage(m) {
  const s = m.id && sessions.get(m.id);
  switch (m.type) {
    case 'sync':                       // client asks for the current session list
      broadcast(sessionsSnapshot());
      break;
    case 'new':
      createSession(m);
      break;
    case 'input':
      if (s && s.state !== 'exited') s.pty.write(m.data);
      break;
    case 'resize':
      if (s && s.state !== 'exited') { try { s.pty.resize(m.cols, m.rows); } catch {} }
      break;
    case 'focus':                      // replay this pane's scrollback
      if (s) broadcast({ type: 'snapshot', id: s.id, data: s.buffer });
      break;
    case 'kill':
      if (s) { try { s.pty.kill(); } catch {} }
      break;
    case 'close':                      // kill the PTY AND remove the session
      if (s) {
        sessions.delete(s.id);
        clearTimeout(s.idleTimer);
        try { s.pty.kill(); } catch {}
        broadcast({ type: 'closed', id: s.id });
      }
      break;
  }
}

// ---- local LAN clients ----
wss.on('connection', (ws) => {
  ws.send(JSON.stringify(sessionsSnapshot()));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    handleMessage(m);
  });
});

// ---- relay host mode (dial OUT) ----
function connectRelay() {
  if (!RELAY_URL) return;
  relayAuthed = false;
  relay = new WebSocket(RELAY_URL);
  relay.on('open', () => relay.send(JSON.stringify({ type: 'hello', role: 'host', token: TOKEN })));
  relay.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!relayAuthed) {
      if (m.type === 'hello_ok') { relayAuthed = true; console.log('[gabriele] relay host up'); }
      return; // ignore anything before auth
    }
    handleMessage(m); // a remote client's message, forwarded by the relay
  });
  relay.on('close', () => { relayAuthed = false; console.log('[gabriele] relay down; retrying'); setTimeout(connectRelay, 2000); });
  relay.on('error', () => { try { relay.close(); } catch {} });
}
connectRelay();
