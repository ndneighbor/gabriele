// Gabriele bridge — runs on the Mac. Hosts long-lived terminal sessions in real
// PTYs (node-pty) and streams their raw output to clients. Clients reach it two ways:
//   • directly over the LAN (ws server on :PORT), or
//   • through a relay it dials OUT to (host mode) — set GABRIELE_RELAY_URL.
// Both sinks share one broadcast path; inbound messages share one handler.

const pty = require('node-pty');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.GABRIELE_PORT || 4848);
const DEFAULT_CMD = process.env.GABRIELE_CMD || 'claude';
const DEFAULT_CWD = process.env.GABRIELE_CWD || process.cwd();
const SKIP_PERMS = process.env.GABRIELE_SKIP_PERMS !== '0'; // claude runs --dangerously-skip-permissions by default
const RELAY_URL = process.env.GABRIELE_RELAY_URL || '';     // if set, dial out to the relay as host
const TOKEN = process.env.GABRIELE_TOKEN || '';
const BUFFER_CAP = 200 * 1024; // per-session scrollback kept for replay
const IDLE_MS = 2000;          // no output this long => "idle" (turn done / awaiting you)
// session resume: persist live channels so a bridge restart re-spawns them and
// resumes each claude conversation (--resume). Disable with GABRIELE_RESUME=0.
const STATE_FILE = process.env.GABRIELE_STATE || path.join(__dirname, '.gab-sessions.json');
const RESUME = process.env.GABRIELE_RESUME !== '0';

// Profiles = which login a channel runs under. Each maps to its own
// CLAUDE_CONFIG_DIR (separate account/auth), so personal vs work never mix.
// configDir null = the standard ~/.claude. Edit bridge/profiles.json to taste.
function loadProfiles() {
  const builtin = [{ id: 'default', label: 'Default', configDir: null }];
  const file = process.env.GABRIELE_PROFILES || path.join(__dirname, 'profiles.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(cfg.profiles) && cfg.profiles.length ? cfg.profiles : builtin;
    return { list, def: cfg.default || list[0].id };
  } catch { return { list: builtin, def: 'default' }; }
}
const { list: PROFILES, def: DEFAULT_PROFILE } = loadProfiles();
const profileById = (id) => PROFILES.find((p) => p.id === id);
const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
console.log(`[gabriele] profiles: ${PROFILES.map((p) => p.id).join(', ')} (default ${DEFAULT_PROFILE})`);

// id -> { id, title, cwd, cmd, state, startedAt, pty, buffer, idleTimer }
const sessions = new Map();
let nextId = 1;

let relay = null;        // ws client to the relay (host mode)
let relayAuthed = false;

const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT });
console.log(`[gabriele] bridge listening on ws://0.0.0.0:${PORT}`);

const meta = (s) => ({ id: s.id, title: s.title, cwd: s.cwd, cmd: s.cmd, state: s.state, startedAt: s.startedAt, profile: s.profile, profileLabel: s.profileLabel, approvals: s.approvals });
const profilesList = () => PROFILES.map((p) => ({ id: p.id, label: p.label }));
const sessionsSnapshot = () => ({ type: 'sessions', sessions: [...sessions.values()].map(meta), profiles: profilesList(), defaultProfile: DEFAULT_PROFILE });

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

function createSession({ cmd, args, cwd, title, cols, rows, profile, approvals, resumeId } = {}) {
  cmd = cmd || DEFAULT_CMD;
  cwd = cwd || DEFAULT_CWD;
  args = args || [];
  const isClaude = /(^|\/)claude$/.test(cmd);

  // tag each claude conversation with a stable session id so it survives a bridge
  // restart: --session-id when fresh, --resume <id> when restoring.
  let sessionId = null;
  if (isClaude) {
    if (resumeId) { sessionId = resumeId; args = ['--resume', resumeId, ...args]; }
    else { sessionId = crypto.randomUUID(); args = ['--session-id', sessionId, ...args]; }
  }

  // fire-and-forget: claude sessions skip permission prompts (nobody's watching mid-game)
  // — UNLESS this is an approval-mode channel, which keeps permissions ON so the
  // PreToolUse hook can route each tool to the phone for allow/deny.
  if (!approvals && SKIP_PERMS && isClaude && !args.includes('--dangerously-skip-permissions')) {
    args = ['--dangerously-skip-permissions', ...args];
  }

  // run this channel under its profile's login (own CLAUDE_CONFIG_DIR)
  const prof = profileById(profile) || profileById(DEFAULT_PROFILE) || PROFILES[0];
  const env = { ...process.env, TERM: 'xterm-256color' };
  if (prof && prof.configDir) env.CLAUDE_CONFIG_DIR = expandHome(prof.configDir);
  else delete env.CLAUDE_CONFIG_DIR; // "default" profile = the standard ~/.claude, regardless of how the bridge was launched
  if (approvals) env.GABRIELE_APPROVALS = '1'; // PreToolUse hook routes this channel's tool calls to the phone
  else delete env.GABRIELE_APPROVALS;

  const term = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: cols || 80, rows: rows || 24,
    cwd,
    env,
  });

  const s = {
    id: String(nextId++),
    title: title || `${cmd.split('/').pop()} · ${cwd.split('/').pop()}`,
    cwd, cmd,
    sessionId,
    profile: prof ? prof.id : null,
    profileLabel: prof ? prof.label : null,
    approvals: !!approvals,
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
    persistSessions();
  });

  broadcast({ type: 'session', meta: meta(s) });
  console.log(`[gabriele] session ${s.id}: ${cmd} @ ${cwd} [${prof ? prof.id : 'default'}]${resumeId ? ' (resumed)' : ''}`);
  persistSessions();
  return s;
}

// Persist the live channels so a bridge restart can bring them back. Only running/
// idle channels are kept — an exited or closed one is dropped (you ended it).
function persistSessions() {
  try {
    const list = [...sessions.values()]
      .filter((s) => s.state !== 'exited')
      .map((s) => ({ sessionId: s.sessionId, cmd: s.cmd, cwd: s.cwd, profile: s.profile, approvals: s.approvals, title: s.title }));
    fs.writeFileSync(STATE_FILE, JSON.stringify(list));
  } catch {}
}

function restoreSessions() {
  if (!RESUME) return;
  let list;
  try { list = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return; }
  if (!Array.isArray(list) || !list.length) return;
  console.log(`[gabriele] restoring ${list.length} channel(s)`);
  for (const e of list) {
    try { createSession({ cmd: e.cmd, cwd: e.cwd, profile: e.profile, approvals: e.approvals, title: e.title, resumeId: e.sessionId }); }
    catch (err) { console.log(`[gabriele] restore failed (${e.cwd}): ${err.message}`); }
  }
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
        persistSessions();
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

restoreSessions(); // bring back channels (+ resume their claude conversations) from a previous run
connectRelay();
