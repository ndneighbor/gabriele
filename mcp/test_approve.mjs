// Drives the real PreToolUse hook (hooks/approve.mjs) against the server.
// Start the server with a short approval timeout first:
//   GABRIELE_APPROVAL_TIMEOUT_MS=2000 PORT=8183 GABRIELE_TOKEN=dev-secret node server.js
import { spawn } from 'node:child_process';
const BASE = process.env.BASE || 'http://localhost:8183';
const TOKEN = process.env.GABRIELE_TOKEN || 'dev-secret';
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); c ? pass++ : fail++; };

function runHook(payload, env = {}) {
  const p = spawn('node', ['hooks/approve.mjs'], { cwd: '/Users/vecino/Development/Development/gabriele/mcp',
    env: { ...process.env, GABRIELE_MCP_URL: BASE, GABRIELE_TOKEN: TOKEN, ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stdin.on('error', () => {});
  const done = new Promise((res) => p.on('close', (code) => res({ code, out })));
  p.stdin.write(JSON.stringify(payload)); p.stdin.end();
  return done;
}
async function waitApproval() {
  for (let i = 0; i < 60; i++) { const j = await (await fetch(`${BASE}/approvals`, { headers: H })).json(); if (j.approvals[0]) return j.approvals[0]; await sleep(100); }
  return null;
}

// allow
let h = runHook({ hook_event_name: 'PreToolUse', cwd: '/x/benchmarks', tool_name: 'Bash', tool_input: { command: 'rm -rf build/' } }, { GABRIELE_APPROVALS: '1' });
let a = await waitApproval();
ok(!!a, `approval surfaced from agent "${a?.agent}": ${a?.tool} "${a?.input}"`);
ok(a?.tool === 'Bash' && a?.input === 'rm -rf build/', 'carries tool name + concise command preview');
await fetch(`${BASE}/approvals/${a.id}/decide`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'allow' }) });
let r = await h;
ok(JSON.parse(r.out || '{}').hookSpecificOutput?.permissionDecision === 'allow', `ALLOW → hook emits permissionDecision allow (exit ${r.code})`);

// deny — Edit shows the file path
h = runHook({ tool_name: 'Edit', cwd: '/x/benchmarks', tool_input: { file_path: '/etc/hosts' } }, { GABRIELE_APPROVALS: '1' });
a = await waitApproval();
ok(a?.tool === 'Edit' && a?.input === '/etc/hosts', 'Edit approval shows the file path');
await fetch(`${BASE}/approvals/${a.id}/decide`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'deny' }) });
r = await h;
ok(JSON.parse(r.out || '{}').hookSpecificOutput?.permissionDecision === 'deny', 'DENY → hook emits permissionDecision deny');

// timeout → ask (server hold is 2s in the test) → passthrough
h = runHook({ tool_name: 'Bash', cwd: '/x', tool_input: { command: 'echo hi' } }, { GABRIELE_APPROVALS: '1' });
r = await h;
ok(r.code === 0 && r.out.trim() === '', 'TIMEOUT → passthrough (exit 0, no output → normal prompt)');

// no GABRIELE_APPROVALS → instant passthrough, never even contacts the server
r = await runHook({ tool_name: 'Bash', tool_input: { command: 'ls' } }, {});
ok(r.code === 0 && r.out.trim() === '', 'NO approvals env → passthrough (other sessions untouched)');

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
