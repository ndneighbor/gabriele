// End-to-end test: drive the MCP server exactly as a real agent + phone would.
//   1. initialize (capture session id)   2. tools/list (handoff present?)
//   3. call handoff (blocks)             4. operator polls /handoffs, replies
//   5. handoff returns the operator's reply
const BASE = process.env.BASE || 'http://localhost:8181';
const TOKEN = process.env.GABRIELE_TOKEN || 'dev-secret';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` };
const ok = (c, m) => console.log(`${c ? '✓' : '✗'} ${m}`) || (c || process.exit(1));

let sid;
async function rpc(method, params) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { ...H, ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }) });
  if (!sid) sid = r.headers.get('mcp-session-id');
  return r.json();
}

// 1. initialize
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '1' } });
ok(init.result?.serverInfo?.name === 'gabriele', `initialize → ${init.result?.serverInfo?.name} (session ${sid?.slice(0, 8)}…)`);
await fetch(`${BASE}/mcp`, { method: 'POST', headers: { ...H, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });

// 2. tools/list
const list = await rpc('tools/list', {});
const tool = (list.result?.tools || []).find((t) => t.name === 'handoff');
ok(!!tool, `tools/list → handoff present (${(list.result?.tools || []).map((t) => t.name).join(', ')})`);
ok(!!tool?.inputSchema?.properties?.summary, 'handoff exposes a "summary" input');

// 3. fire handoff — DO NOT await yet; it blocks until the operator replies
const callP = rpc('tools/call', { name: 'handoff', arguments: { summary: 'Migrated 12 files', question: 'Run the test suite now?', choices: ['yes', 'wait'] } });

// 4. operator side: poll until the handoff shows up, then reply
let h, tries = 0;
while (!h && tries++ < 50) {
  const q = await (await fetch(`${BASE}/handoffs`, { headers: H })).json();
  h = (q.handoffs || [])[0];
  if (!h) await new Promise((r) => setTimeout(r, 100));
}
ok(!!h, `operator sees pending handoff from "${h?.agent}": “${h?.summary}”`);
ok(h?.question === 'Run the test suite now?' && h?.choices?.length === 2, 'handoff carries question + choices');
const rep = await (await fetch(`${BASE}/handoffs/${h.id}/reply`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'yes — go' }) })).json();
ok(rep.ok, 'operator reply accepted');

// 5. the agent's blocked tool call now returns the reply
const call = await callP;
const text = call.result?.content?.[0]?.text;
ok(text === 'yes — go', `handoff returned operator reply → “${text}”`);

// auth check
const un = await fetch(`${BASE}/handoffs`, { headers: { accept: 'application/json' } });
ok(un.status === 401, `unauthorized request rejected (${un.status})`);
console.log('\nALL GREEN');
