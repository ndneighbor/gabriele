#!/usr/bin/env node
// Claude Code **Stop hook** → push the agent's last response to Gabriele (your
// phone's notifications feed). Works on ANY Claude Code session, in or out of
// the bridge. ALWAYS exits 0 — it's a notification, it never blocks the stop.
//
// Register in ~/.claude/settings.json (see mcp/hooks/README.md):
//   GABRIELE_MCP_URL=https://…  GABRIELE_TOKEN=…  node …/stop-notify.mjs
import fs from 'node:fs';

const MCP = (process.env.GABRIELE_MCP_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.GABRIELE_TOKEN || '';
const done = () => process.exit(0); // never block the stop, never loop
if (!MCP || !TOKEN) done();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  let p = {};
  try { p = JSON.parse(input); } catch {}
  let text = '', cwd = p.cwd || '';
  try {
    // scan the transcript backward for the last assistant message that has text
    // (skip trailing tool_use-only messages)
    const lines = fs.readFileSync(p.transcript_path, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      const m = o.message || o;
      if ((m.role || o.type) === 'assistant' && Array.isArray(m.content)) {
        const t = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (t) { text = t; if (!cwd && o.cwd) cwd = o.cwd; break; }
      }
    }
  } catch {}
  if (!text) done();

  const agent = cwd.split('/').pop() || 'claude'; // label by project dir
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 5000); // don't hang the stop on a slow network
  try {
    await fetch(`${MCP}/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ agent, text: text.slice(0, 2000), cwd }),
      signal: ctrl.signal,
    });
  } catch {}
  clearTimeout(to);
  done();
});
