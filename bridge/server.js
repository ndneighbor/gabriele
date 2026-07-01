// Gabriele bridge — runs on the Mac. Hosts long-lived terminal sessions in real
// PTYs (node-pty) and streams their raw output to clients. Clients reach it two ways:
//   • directly over the LAN (ws server on :PORT), or
//   • through a relay it dials OUT to (host mode) — set GABRIELE_RELAY_URL.
// Both sinks share one broadcast path; inbound messages share one handler.

const pty = require('node-pty');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.GABRIELE_PORT || 4848);
const DEFAULT_CMD = process.env.GABRIELE_CMD || 'codex';
const DEFAULT_ARGS = parseArgs(process.env.GABRIELE_ARGS || '');
const DEFAULT_CWD = process.env.GABRIELE_CWD || process.cwd();
const SKIP_PERMS = process.env.GABRIELE_SKIP_PERMS !== '0'; // Claude Code can run --dangerously-skip-permissions by default
const RELAY_URL = process.env.GABRIELE_RELAY_URL || '';     // if set, dial out to the relay as host
const TOKEN = process.env.GABRIELE_TOKEN || '';
const HOOK_PORT = Number(process.env.GABRIELE_HOOK_PORT || (PORT + 1));
const HOOK_TOKEN = process.env.GABRIELE_HOOK_TOKEN || crypto.randomBytes(18).toString('base64url');
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

function parseArgs(s) {
  if (!s.trim()) return [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {}
  return s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((p) => p.replace(/^(['"])(.*)\1$/, '$2')) || [];
}

function agentKind(cmd) {
  const base = path.basename(cmd || '').toLowerCase();
  if (base === 'claude' || base === 'claude-code') return 'claude';
  if (base === 'codex') return 'codex';
  return base || 'agent';
}

// Where a channel's claude transcripts live: <configDir>/projects/. The default
// profile uses ~/.claude; a per-profile channel uses its own CLAUDE_CONFIG_DIR.
function configDirFor(profile) {
  const prof = profileById(profile);
  return prof && prof.configDir ? expandHome(prof.configDir) : path.join(os.homedir(), '.claude');
}

// Has claude actually saved a conversation for this session id? Transcripts are
// <configDir>/projects/<sanitized-cwd>/<id>.jsonl, but claude's cwd->dir sanitizer
// isn't a plain substitution (it strips every non-alphanumeric char and hash-
// truncates long paths), so we don't reconstruct it — we look for the uniquely-
// named <id>.jsonl anywhere under projects/ (session ids are UUIDs). No transcript
// => --resume would die with "No conversation found", so the caller starts fresh.
function transcriptExists(sessionId, profile) {
  if (!sessionId) return false;
  const projects = path.join(configDirFor(profile), 'projects');
  const file = `${sessionId}.jsonl`;
  let dirs;
  try { dirs = fs.readdirSync(projects); } catch { return false; }
  for (const d of dirs) {
    try { if (fs.existsSync(path.join(projects, d, file))) return true; } catch {}
  }
  return false;
}

// id -> { id, title, cwd, cmd, state, startedAt, pty, buffer, idleTimer }
const sessions = new Map();
let nextId = 1;
const clients = new Map(); // clientId -> { kind, lastSeen }

let relay = null;        // ws client to the relay (host mode)
let relayAuthed = false;

const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT });
console.log(`[gabriele] bridge listening on ws://0.0.0.0:${PORT}`);

const meta = (s) => ({ id: s.id, title: s.title, cwd: s.cwd, cmd: s.cmd, kind: s.kind, state: s.state, startedAt: s.startedAt, profile: s.profile, profileLabel: s.profileLabel, approvals: s.approvals, cols: s.cols, rows: s.rows, sizeOwner: s.sizeOwner });
const profilesList = () => PROFILES.map((p) => ({ id: p.id, label: p.label }));
const sessionsSnapshot = () => ({ type: 'sessions', sessions: [...sessions.values()].map(meta), profiles: profilesList(), defaultProfile: DEFAULT_PROFILE });

function noteClient(m) {
  if (!m.clientId) return;
  clients.set(m.clientId, { kind: m.clientKind || 'unknown', lastSeen: Date.now() });
}

function hasRecentDesktop(exceptId) {
  const now = Date.now();
  for (const [id, c] of clients) {
    if (now - c.lastSeen > 15_000) { clients.delete(id); continue; }
    if (id !== exceptId && c.kind === 'desktop') return true;
  }
  return false;
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);          // local LAN clients
  if (relay && relayAuthed && relay.readyState === 1) relay.send(data);        // remote clients via relay
}

function turnDonePayload(s, source, extra = {}) {
  const title = extra.title || `${s.kind === 'codex' ? 'Codex' : s.kind || 'Agent'} completed`;
  return {
    type: 'turn_done',
    id: s.id,
    sessionId: s.sessionId || null,
    agent: extra.agent || s.kind || 'agent',
    title,
    body: extra.body || extra.text || s.title,
    cwd: extra.cwd || s.cwd,
    source,
    at: Date.now(),
  };
}

function publishTurnDone(s, source, extra) {
  const now = Date.now();
  if (now - (s.lastTurnDoneAt || 0) < 3000) return;
  s.lastTurnDoneAt = now;
  s.pendingTurn = false;
  broadcast(turnDonePayload(s, source, extra));
}

function findSessionForHook(payload) {
  if (payload.id && sessions.has(String(payload.id))) return sessions.get(String(payload.id));
  if (payload.sessionId) {
    for (const s of sessions.values()) if (s.sessionId === payload.sessionId) return s;
  }
  if (payload.cwd) {
    const candidates = [...sessions.values()]
      .filter((s) => s.cwd === payload.cwd && (!payload.agent || s.kind === payload.agent))
      .sort((a, b) => b.startedAt - a.startedAt);
    if (candidates[0]) return candidates[0];
  }
  return null;
}

function setState(s, state) {
  if (!sessions.has(s.id)) return; // closed/removed — don't resurrect it
  if (s.state === state) return;
  const was = s.state;
  s.state = state;
  broadcast({ type: 'session', meta: meta(s) });
  if (was === 'running' && state === 'idle' && s.pendingTurn) publishTurnDone(s, 'idle');
}

// One coherent current frame for focus/replay: exit alt-screen + clear + home +
// reset SGR, then the serialized screen (serialize re-enters alt-screen for a TUI).
function broadcastSnapshot(s) {
  if (!sessions.has(s.id)) return;
  try {
    const frame = '\x1b[?1049l\x1b[2J\x1b[3J\x1b[H\x1b[0m' + s.ser.serialize();
    broadcast({ type: 'snapshot', id: s.id, data: frame });
  } catch {}
}

// Guarded resize: drop out-of-order (gen), floor to a usable grid, dedupe, then
// resize the PTY AND the headless mirror and push the reflowed frame.
function applyResize(s, m) {
  noteClient(m);
  if (m.clientKind === 'mobile' && hasRecentDesktop(m.clientId)) {
    broadcast({ type: 'session', meta: meta(s) });
    return;
  }
  if (typeof m.gen === 'number' && m.gen < s.sizeGen) return;
  if (typeof m.gen === 'number') s.sizeGen = m.gen;
  const cols = Math.max(20, m.cols | 0), rows = Math.max(6, m.rows | 0); // rows floor keeps claude's input box on-screen
  if (cols === s.cols && rows === s.rows) return;                        // dedupe — no SIGWINCH, no reflow flicker
  s.cols = cols; s.rows = rows;
  s.sizeOwner = { id: m.clientId || null, kind: m.clientKind || 'unknown', at: Date.now() };
  try { s.pty.resize(cols, rows); } catch {}
  try { s.emu.resize(cols, rows); } catch {}
  broadcast({ type: 'session', meta: meta(s) });
  broadcastSnapshot(s);
}

// Drop any id flag a value may carry so it's re-derived cleanly below — guards against
// a legacy state file persisted before the flag was kept out of the saved args.
function stripIdFlags(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === '--session-id' || arr[i] === '--resume') { i++; continue; } // skip flag + its value
    out.push(arr[i]);
  }
  return out;
}

function createSession({ cmd, args, cwd, title, cols, rows, profile, approvals, resumeId, clientId, clientKind } = {}) {
  cmd = cmd || DEFAULT_CMD;
  cwd = cwd || DEFAULT_CWD;
  const id = String(nextId++);
  const extraArgs = stripIdFlags(args || [...DEFAULT_ARGS]); // user/agent args ONLY — the id flag is re-derived each spawn, never persisted (else it accumulates on every restore)
  args = extraArgs;
  const kind = agentKind(cmd);
  const isClaude = kind === 'claude';

  // tag each claude conversation with a stable session id so it survives a bridge
  // restart: --session-id when fresh, --resume <id> when restoring. But only --resume
  // if claude actually saved that conversation — if the prior claude was killed before
  // it wrote a transcript, --resume dies with "No conversation found" and the restored
  // channel is dead on arrival. In that case start FRESH under the same stable id, so
  // the channel is immediately usable (new conversation, same id) instead of an error.
  let sessionId = null, resumed = false;
  if (isClaude) {
    if (resumeId && transcriptExists(resumeId, profile)) {
      sessionId = resumeId; resumed = true; args = ['--resume', resumeId, ...extraArgs];
    } else if (resumeId) {
      sessionId = resumeId; args = ['--session-id', resumeId, ...extraArgs];
    } else {
      sessionId = crypto.randomUUID(); args = ['--session-id', sessionId, ...extraArgs];
    }
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
  env.GABRIELE_NOTIFY_URL = `http://127.0.0.1:${HOOK_PORT}/turn_done`;
  env.GABRIELE_NOTIFY_TOKEN = HOOK_TOKEN;
  env.GABRIELE_SESSION_ID = id;
  env.GABRIELE_AGENT_KIND = kind;

  const startCols = cols || 80, startRows = rows || 24;
  const term = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: startCols, rows: startRows,
    cwd,
    env,
  });

  // headless xterm mirrors the live screen, so focus replays ONE coherent frame
  // (serialize) instead of the raw redraw history — which is what smears a TUI.
  const emu = new HeadlessTerminal({ cols: startCols, rows: startRows, scrollback: 1000, allowProposedApi: true });
  const ser = new SerializeAddon();
  emu.loadAddon(ser);

  const s = {
    id,
    title: title || `${cmd.split('/').pop()} · ${cwd.split('/').pop()}`,
    cwd, cmd, args, extraArgs,
    kind,
    sessionId,
    profile: prof ? prof.id : null,
    profileLabel: prof ? prof.label : null,
    approvals: !!approvals,
    state: 'running',
    startedAt: Date.now(),
    pty: term,
    emu, ser,
    cols: startCols, rows: startRows, sizeGen: 0,
    sizeOwner: { id: clientId || null, kind: clientKind || 'initial', at: Date.now() },
    resnapTimer: null,
    idleTimer: null,
    pendingTurn: false,
    lastTurnDoneAt: 0,
  };
  sessions.set(s.id, s);

  term.onData((data) => {
    if (!sessions.has(s.id)) return; // closed/removed — ignore late output
    s.emu.write(data);                              // mirror into the headless screen (the replay source)
    broadcast({ type: 'data', id: s.id, data });    // live delta to attached clients
    setState(s, 'running');
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => setState(s, 'idle'), IDLE_MS);
    clearTimeout(s.resnapTimer);                     // once output settles, push a clean frame so the relay cache stays coherent
    s.resnapTimer = setTimeout(() => broadcastSnapshot(s), 250);
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
  console.log(`[gabriele] session ${s.id}: ${cmd} @ ${cwd} [${prof ? prof.id : 'default'}]${resumed ? ' (resumed)' : resumeId ? ' (restored fresh — no transcript)' : ''}`);
  persistSessions();
  return s;
}

// Persist the live channels so a bridge restart can bring them back. Only running/
// idle channels are kept — an exited or closed one is dropped (you ended it).
function persistSessions() {
  try {
    const list = [...sessions.values()]
      .filter((s) => s.state !== 'exited')
      .map((s) => ({ sessionId: s.sessionId, cmd: s.cmd, cwd: s.cwd, profile: s.profile, approvals: s.approvals, title: s.title, args: s.extraArgs }));
    fs.writeFileSync(STATE_FILE, JSON.stringify(list));
  } catch {}
}

function startHookServer() {
  const server = http.createServer((req, res) => {
    const done = (code, text) => {
      res.writeHead(code, { 'content-type': 'text/plain' });
      res.end(text || '');
    };

    if (req.method !== 'POST' || req.url !== '/turn_done') return done(404, 'not found');
    if (req.headers.authorization !== `Bearer ${HOOK_TOKEN}`) return done(401, 'unauthorized');

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { return done(400, 'bad json'); }
      const s = findSessionForHook(payload);
      if (!s) return done(404, 'session not found');
      publishTurnDone(s, payload.source || 'hook', payload);
      done(204);
    });
  });

  server.listen(HOOK_PORT, '127.0.0.1', () => {
    console.log(`[gabriele] hook notify listening on http://127.0.0.1:${HOOK_PORT}/turn_done`);
  });
  server.on('error', (err) => console.log(`[gabriele] hook notify unavailable: ${err.message}`));
}

function restoreSessions() {
  if (!RESUME) return;
  let list;
  try { list = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return; }
  if (!Array.isArray(list) || !list.length) return;
  console.log(`[gabriele] restoring ${list.length} channel(s)`);
  for (const e of list) {
    try { createSession({ cmd: e.cmd, args: e.args, cwd: e.cwd, profile: e.profile, approvals: e.approvals, title: e.title, resumeId: e.sessionId }); }
    catch (err) { console.log(`[gabriele] restore failed (${e.cwd}): ${err.message}`); }
  }
}

// One inbound handler for both local clients and relay-forwarded clients.
// Replies broadcast (the relay can't target one remote client) — clients filter by id.
function handleMessage(m) {
  noteClient(m);
  const s = m.id && sessions.get(m.id);
  switch (m.type) {
    case 'client_hello':
      break;
    case 'sync':                       // client asks for the current session list
      broadcast(sessionsSnapshot());
      break;
    case 'new':
      createSession(m);
      break;
    case 'input':
      if (s && s.state !== 'exited') { s.pendingTurn = true; s.pty.write(m.data); }
      break;
    case 'prompt': {                     // no target id (e.g. bridge/send.js) — fire at the newest live session
      const target = [...sessions.values()].filter((x) => x.state !== 'exited').sort((a, b) => b.startedAt - a.startedAt)[0];
      if (target && typeof m.text === 'string') { target.pendingTurn = true; target.pty.write(m.text + '\r'); }
      break;
    }
    case 'resize':
      if (s && s.state !== 'exited') applyResize(s, m);
      break;
    case 'focus':                      // push a clean current frame (serialized), not raw history
      if (s) broadcastSnapshot(s);
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
wss.on('connection', (ws, req) => {
  try { req.socket.setNoDelay(true); } catch {} // LAN-direct: no Nagle either
  ws.send(JSON.stringify(sessionsSnapshot()));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong', t: m.t })); } catch {} return; } // latency probe
    handleMessage(m);
  });
});

// ---- relay host mode (dial OUT) ----
function connectRelay() {
  if (!RELAY_URL) return;
  relayAuthed = false;
  relay = new WebSocket(RELAY_URL);
  relay.on('open', () => {
    try { relay._socket && relay._socket.setNoDelay(true); } catch {} // no Nagle on the relay hop — keystrokes ship immediately
    relay.send(JSON.stringify({ type: 'hello', role: 'host', token: TOKEN }));
  });
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
startHookServer();
connectRelay();
