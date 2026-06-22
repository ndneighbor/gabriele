// Simulate a blocked tool call: POST an approval and block until the phone decides.
const BASE = process.env.BASE || 'http://localhost:8181';
const TOKEN = process.env.GABRIELE_TOKEN || 'dev-secret';
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
console.log('approval posted — blocking for your decision on the phone…');
const r = await fetch(`${BASE}/approvals`, { method: 'POST', headers: H, body: JSON.stringify({
  agent: 'benchmarks', tool: 'Bash', input: 'rm -rf node_modules && npm install', cwd: '/Users/vecino/Development/Development/benchmarks',
}) });
console.log('DECISION:', (await r.json()).decision);
