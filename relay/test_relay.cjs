// Exercises the stateful relay end-to-end with real ws connections.
// Run a local relay first:  GABRIELE_RELAY_SECRET=dev-secret GABRIELE_PING_MS=1000 PORT=4000 mix run --no-halt
const WebSocket = require('/Users/vecino/Development/Development/gabriele/node_modules/ws');
const URL = 'ws://localhost:4000/ws';
const TOKEN = 'dev-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); c ? pass++ : fail++; };

function conn(role, opts = {}) {
  const ws = new WebSocket(URL, { autoPong: opts.autoPong !== false });
  const log = [];
  const o = { ws, log, role, closed: false };
  ws.on('message', (d) => { let m; try { m = JSON.parse(d.toString()); } catch { return; } log.push(m); opts.onMsg && opts.onMsg(o, m); });
  ws.on('close', () => { o.closed = true; });
  ws.on('error', () => {});
  o.ready = new Promise((res) => ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', role, token: TOKEN })); res(); }));
  o.send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };
  o.has = (t) => log.some((m) => m.type === t);
  o.count = (t) => log.filter((m) => m.type === t).length;
  o.last = (t) => [...log].reverse().find((m) => m.type === t);
  return o;
}

function hostSim(initial = []) {
  const sessions = [...initial];
  const o = conn('host', { onMsg: (self, m) => {
    if (m.type === 'sync') self.send({ type: 'sessions', sessions, profiles: [{ id: 'work', label: 'Work' }], defaultProfile: 'work' });
    if (m.type === 'new') { const id = String(sessions.length + 1); sessions.push({ id, cmd: 'claude', state: 'running', startedAt: Date.now() + sessions.length }); self.send({ type: 'session', meta: sessions[sessions.length - 1] }); }
  } });
  o.createSession = (id) => { sessions.push({ id, cmd: 'claude', state: 'running', startedAt: Date.now() }); o.send({ type: 'session', meta: sessions[sessions.length - 1] }); };
  o.addData = (id, data) => o.send({ type: 'data', id, data });
  return o;
}

(async () => {
  // A — backend state: a late-joining client gets full state from the RELAY cache
  const h1 = hostSim();
  await h1.ready; await sleep(150);
  h1.createSession('1');
  await sleep(150);
  const c1 = conn('client');           // sends only `hello` — never `sync`
  await c1.ready; await sleep(250);
  ok(c1.has('hello_ok'), 'A: client authed');
  const snap = c1.last('sessions');
  ok(snap && snap.sessions.some((s) => s.id === '1'), 'A: late-join client gets session 1 from RELAY CACHE on connect (no sync sent)');
  ok(snap && (snap.profiles || []).length > 0, 'A: cached state includes profiles');

  // B — focus answered from the relay's per-session scrollback cache
  h1.addData('1', 'hello-world-scrollback');
  await sleep(150);
  c1.send({ type: 'focus', id: '1' });
  await sleep(200);
  const sn = c1.last('snapshot');
  ok(sn && sn.id === '1' && sn.data.includes('hello-world-scrollback'), 'B: focus answered from relay cache with buffered data');

  // C — client sync is cache-answered, NOT forwarded to the host
  const hSync = h1.count('sync');
  c1.send({ type: 'sync' });
  await sleep(200);
  ok(c1.count('sessions') >= 2, 'C: client sync got a fresh sessions snapshot');
  ok(h1.count('sync') === hSync, 'C: client sync was NOT forwarded to the host');

  // D — phantom fix: `new` with no host is dropped; a reconnecting host gets ZERO replayed `new`
  h1.ws.close(); await sleep(300);
  ok(c1.has('host_down'), 'D: client saw host_down');
  c1.send({ type: 'new' }); c1.send({ type: 'new' });   // stale client tries to spawn — must be dropped
  await sleep(200);
  const h2 = hostSim();                  // fresh bridge, 0 sessions
  await h2.ready; await sleep(350);
  ok(h2.count('new') === 0, 'D: reconnecting host receives ZERO replayed `new` (PHANTOM FIX)');
  ok(h2.count('sync') === 1, 'D: Room sent the host exactly one sync to refresh its cache');

  // E — host reconnect clears ghosts (empty fresh snapshot replaces stale cache)
  await sleep(150);
  const after = c1.last('sessions');
  ok(after && after.sessions.length === 0, 'E: stale session cleared after fresh host snapshot (no dead-PTY ghosts)');

  // F — one host per room
  const h3 = conn('host');
  await h3.ready; await sleep(300);
  ok(h3.closed && !h3.has('hello_ok'), 'F: a second host in the room is rejected');

  // G — reaper: a client that stops pong-ing is reaped (~3s at PING_MS=1000)
  const z = conn('client', { autoPong: false });
  await z.ready; await sleep(200);
  ok(!z.closed, 'G: zombie connected');
  await sleep(4500);
  ok(z.closed, 'G: non-pong-ing client reaped by the relay');

  console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  try { h2.ws.close(); c1.ws.close(); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
