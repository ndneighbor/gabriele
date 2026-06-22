#!/usr/bin/env node
// Claude Code **PreToolUse hook** → route a proposed tool to the phone for
// allow/deny. Blocks until the operator decides; on timeout or any failure it
// returns nothing (= normal permission prompt). NEVER auto-allows.
//
// Only active when GABRIELE_APPROVALS is set (the bridge sets it on approval-mode
// channels), so it's a no-op for every other Claude Code session. The install
// command shell-guards on that var so node doesn't even start otherwise.
import process from 'node:process';

const MCP = (process.env.GABRIELE_MCP_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.GABRIELE_TOKEN || '';
// exit 0 with NO stdout = "proceed with the normal permission flow" (safe default)
const passthrough = () => process.exit(0);
function decide(permissionDecision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason },
  }));
  process.exit(0);
}
if (!process.env.GABRIELE_APPROVALS || !MCP || !TOKEN) passthrough();

// concise, per-tool preview of what the agent wants to do
function preview(tool, input) {
  if (!input || typeof input !== 'object') return String(input ?? '');
  if (tool === 'Bash') return input.command || '';
  if (/Edit|Write|NotebookEdit/.test(tool)) return input.file_path || input.notebook_path || '';
  if (tool === 'WebFetch') return input.url || '';
  if (tool === 'WebSearch') return input.query || '';
  return JSON.stringify(input);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  let p = {};
  try { p = JSON.parse(input); } catch { passthrough(); }
  const tool = p.tool_name || 'tool';
  const cwd = p.cwd || '';
  const agent = cwd.split('/').pop() || 'claude';
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 100000); // backstop > server hold; on abort -> passthrough
  try {
    const r = await fetch(`${MCP}/approvals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ agent, tool, input: preview(tool, p.tool_input), cwd }),
      signal: ctrl.signal,
    });
    clearTimeout(to);
    if (!r.ok) passthrough();
    const { decision } = await r.json();
    if (decision === 'allow') decide('allow', 'Approved from your phone');
    if (decision === 'deny') decide('deny', 'Denied from your phone');
    passthrough(); // 'ask' or anything else -> normal prompt
  } catch { clearTimeout(to); passthrough(); }
});
