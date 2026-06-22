// Post a handoff to the MCP and block — leaves it PENDING so the phone shows the
// card. Prints the operator's reply when they answer (resolving the tool call).
const BASE = process.env.BASE || 'http://localhost:8181';
const TOKEN = process.env.GABRIELE_TOKEN || 'dev-secret';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` };
let sid;
async function rpc(method, params) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { ...H, ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }) });
  if (!sid) sid = r.headers.get('mcp-session-id');
  return r.json();
}
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } });
await fetch(`${BASE}/mcp`, { method: 'POST', headers: { ...H, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
console.log('handoff posted — blocking for operator reply…');
const call = await rpc('tools/call', { name: 'handoff', arguments: {
  summary: 'Finished the auth refactor — 3 files changed, tests green.',
  question: 'Ship it or review the diff first?',
  choices: ['ship it', 'review first'],
} });
console.log('REPLY:', call.result?.content?.[0]?.text);
