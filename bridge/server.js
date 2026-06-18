// Gabriele bridge — runs on the Mac. Hosts long-lived terminal sessions in
// real PTYs (node-pty) and streams their raw output to any connected overlay
// over the LAN; keystrokes stream back. Each session is an interactive process
// (default: `claude`) — a real terminal, not a headless one-shot.

const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.GABRIELE_PORT || 4848);
const DEFAULT_CMD = process.env.GABRIELE_CMD || 'claude';
const DEFAULT_CWD = process.env.GABRIELE_CWD || process.cwd();
const BUFFER_CAP = 200 * 1024; // per-session scrollback kept for replay
const IDLE_MS = 2000;          // no output this long => "idle" (turn done / awaiting you)

// id -> { id, title, cwd, cmd, state, startedAt, pty, buffer, idleTimer }
const sessions = new Map();
let nextId = 1;

const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT });
console.log(`[gabriele] bridge listening on ws://0.0.0.0:${PORT}`);

const meta = (s) => ({ id: s.id, title: s.title, cwd: s.cwd, cmd: s.cmd, state: s.state, startedAt: s.startedAt });
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}
function setState(s, state) {
  if (s.state === state) return;
  s.state = state;
  broadcast({ type: 'session', meta: meta(s) });
}

function createSession({ cmd, args, cwd, title, cols, rows } = {}) {
  cmd = cmd || DEFAULT_CMD;
  cwd = cwd || DEFAULT_CWD;
  args = args || [];

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
    s.buffer += data;
    if (s.buffer.length > BUFFER_CAP) s.buffer = s.buffer.slice(-BUFFER_CAP);
    broadcast({ type: 'data', id: s.id, data });
    setState(s, 'running');
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => setState(s, 'idle'), IDLE_MS);
  });

  term.onExit(({ exitCode }) => {
    clearTimeout(s.idleTimer);
    s.state = 'exited';
    broadcast({ type: 'exit', id: s.id, code: exitCode });
    broadcast({ type: 'session', meta: meta(s) });
  });

  broadcast({ type: 'session', meta: meta(s) });
  console.log(`[gabriele] session ${s.id}: ${cmd} @ ${cwd}`);
  return s;
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'sessions', sessions: [...sessions.values()].map(meta) }));

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const s = m.id && sessions.get(m.id);

    switch (m.type) {
      case 'new':
        createSession(m);
        break;
      case 'input':
        if (s && s.state !== 'exited') s.pty.write(m.data);
        break;
      case 'resize':
        if (s && s.state !== 'exited') { try { s.pty.resize(m.cols, m.rows); } catch {} }
        break;
      case 'focus': // overlay opened this pane — replay its scrollback
        if (s) ws.send(JSON.stringify({ type: 'snapshot', id: s.id, data: s.buffer }));
        break;
      case 'kill':
        if (s) { try { s.pty.kill(); } catch {} }
        break;
    }
  });
});
