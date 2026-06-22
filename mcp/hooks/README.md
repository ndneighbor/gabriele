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
