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

# Codex overlay completion — `codex-stop-notify.mjs`

`codex-stop-notify.mjs` is a Codex **Stop hook**. When Codex finishes a turn,
it tells the local Gabriele bridge, which then broadcasts `turn_done` to the
overlay. The hook is a silent no-op unless the bridge spawned that Codex session
and injected `GABRIELE_NOTIFY_URL`, `GABRIELE_NOTIFY_TOKEN`, and
`GABRIELE_SESSION_ID`.

The bridge side is repo code in `bridge/server.js`. It starts a localhost hook
endpoint at `http://127.0.0.1:$GABRIELE_HOOK_PORT/turn_done` (`GABRIELE_PORT + 1`
by default) and authenticates hook posts with `GABRIELE_NOTIFY_TOKEN`.

This hook is a belt-and-suspenders completion signal. The overlay also listens
for the bridge's normal `running -> idle` state transition, so bridge-spawned
sessions can still show completion toasts even before the Codex hook path is
installed or trusted.

Add this to `~/.codex/hooks.json` or a project `.codex/hooks.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /Users/vecino/Development/Development/gabriele/mcp/hooks/codex-stop-notify.mjs",
            "timeout": 5,
            "statusMessage": "Notifying Gabriele"
          }
        ]
      }
    ]
  }
}
```

Then run `/hooks` in Codex and trust the hook. Codex skips non-managed command
hooks until their exact definition is reviewed and trusted.

Important boundary: `codex-stop-notify.mjs` is tracked in this repo;
`~/.codex/hooks.json` is machine-local user config and is not committed here.

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
