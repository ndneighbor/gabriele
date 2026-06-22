# Stop hook — push every agent response to your phone

`stop-notify.mjs` is a Claude Code **Stop hook**. When any Claude Code session
finishes a turn, it reads the transcript, grabs the agent's last text response,
and POSTs it to the Gabriele MCP server's `/notify` feed — which your phone
polls. So you see turns finish on *any* session (in or out of the bridge),
passively, without the agent having to call `handoff`.

It **always exits 0** — it never blocks the stop and never loops.

## Install

Add to `~/.claude/settings.json` (user-wide) — or a project's `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "GABRIELE_MCP_URL=https://gabriele-mcp-production.up.railway.app GABRIELE_TOKEN=<your-secret> node /Users/vecino/Development/Development/gabriele/mcp/hooks/stop-notify.mjs",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

- `GABRIELE_MCP_URL` — the deployed MCP base (no trailing `/mcp`).
- `GABRIELE_TOKEN` — the relay secret (same token the connector/CLI use).
- If either env var is missing the hook is a silent no-op, so it's safe to leave
  configured on machines that aren't set up.

## Pairs with `handoff`

- **`handoff`** (MCP tool) — *active*: the agent asks you a question and blocks for a reply.
- **Stop hook** — *passive*: every finished turn shows up on your phone automatically.

Together: you see what agents are doing, and they pull you in when they need you.

---

# Remote approvals — `approve.mjs` (PreToolUse hook)

When a channel runs in **approval mode** (the bridge sets `GABRIELE_APPROVALS=1`,
and runs claude *without* `--dangerously-skip-permissions`), this hook routes each
consequential tool call to your phone: a card with **Allow / Deny**, and claude
blocks until you decide. On timeout or any failure it returns nothing → the normal
permission prompt. It **never auto-allows**.

It's a no-op for every other session (the install command shell-guards on
`GABRIELE_APPROVALS`, so node doesn't even start otherwise — your normal Claude
Code sessions are untouched).

## Install (both hooks)

`~/.claude/settings.json` (replace `<secret>`):

```json
{
  "hooks": {
    "Stop": [
      { "matcher": "*", "hooks": [
        { "type": "command", "timeout": 10,
          "command": "GABRIELE_MCP_URL=https://gabriele-mcp-production.up.railway.app GABRIELE_TOKEN=<secret> node /Users/vecino/Development/Development/gabriele/mcp/hooks/stop-notify.mjs" } ] }
    ],
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch", "hooks": [
        { "type": "command", "timeout": 120,
          "command": "[ -z \"$GABRIELE_APPROVALS\" ] && exit 0; GABRIELE_MCP_URL=https://gabriele-mcp-production.up.railway.app GABRIELE_TOKEN=<secret> node /Users/vecino/Development/Development/gabriele/mcp/hooks/approve.mjs" } ] }
    ]
  }
}
```

- `matcher` picks which tools require approval — read-only tools (Read/Grep/Glob/LS) are deliberately excluded. Widen/narrow to taste.
- `timeout` (120s) must exceed the server's approval hold (`GABRIELE_APPROVAL_TIMEOUT_MS`, default 90s).

## Use it

On the phone, flip **GUARD** on (header), then create a channel — it spawns in
approval mode (◆ on the chip). Anything it tries to Bash/Edit/Write pops an
Allow/Deny card. Flip GUARD off for fire-and-forget channels.
