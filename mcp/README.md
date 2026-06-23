# gabriele-mcp — the agent → operator handoff bridge

An **agent-agnostic** MCP server. *Any* MCP-speaking agent — Claude Code, Codex,
Cursor, your own Agent SDK script — registers it and calls one tool, `handoff`,
to reach you on your phone and block for an answer.

## Why it exists

MCP is *pull*: the agent calls tools; nothing can push a prompt into a running
session from outside. We invert that — `handoff` holds the tool call open until a
human replies, so the reply arrives as the tool's return value. The agent reads
it like any tool result. No PTY, no relay tap — it works on *any* session,
including a Claude Desktop one you otherwise can't reach.

```
 agent  --handoff(summary, question, choices)-->  [pending queue]  <--poll / reply--  phone
           <------------- operator's reply (returned as the tool result) -------------
```

## Run

```bash
npm install
GABRIELE_TOKEN=<your-secret> npm start          # listens on :8181
```

| env | default | meaning |
|-----|---------|---------|
| `PORT` | `8181` | listen port (Railway injects this) |
| `GABRIELE_TOKEN` | `dev-secret` | bearer token for both `/mcp` and the operator API (reuse the relay secret) |
| `GABRIELE_HANDOFF_TIMEOUT_MS` | `240000` | how long a handoff blocks before telling the agent to use its judgment |

## Register it with an agent

**Claude Code** (CLI or Desktop — Desktop honors the same MCP config):

```bash
claude mcp add --transport http gabriele \
  https://<your-host>/mcp \
  --header "Authorization: Bearer <your-secret>"
```

**Any other HTTP-transport MCP client** (Codex, Cursor, Agent SDK): point it at
the `/mcp` URL and send `Authorization: Bearer <your-secret>`. The agent is
identified automatically from its MCP `clientInfo.name`, so each handoff is
labeled by *which* agent asked.

Then tell the agent to actually use it — one line in `CLAUDE.md` / system prompt:

> When you finish a step, hit a decision point, or need my input, call the
> `handoff` tool with a short summary and treat its return value as my
> instruction. If you have a question, pass it; offer `choices` when you can.

## Operator API (what the phone talks to)

All require `Authorization: Bearer <token>`.

- `GET /handoffs` → `{ handoffs: [{ id, agent, summary, question, choices, createdAt }] }` — the pending queue.
- `POST /handoffs/:id/reply` `{ "text": "…" }` → unblocks that agent's `handoff` call with `text`.
- `GET /healthz` → `{ ok, pending }` (no auth).

## Test

```bash
GABRIELE_TOKEN=dev-secret npm start &
node test_handoff.mjs        # drives a full initialize → handoff → reply round-trip
```

## ADB MCP

There is also a local Android-control MCP server for emulator/device testing:

```bash
GABRIELE_TOKEN=<your-secret> npm run adb
```

It listens on `:8182` by default (`GABRIELE_ADB_MCP_PORT` overrides it) and
uses the same Streamable HTTP MCP endpoint:

```bash
http://localhost:8182/mcp
Authorization: Bearer <your-secret>
```

Tools include:

- `devices` / `restart_server`
- `tap`, `text`, `keyevent`
- `screenshot`
- `reverse`
- `open_expo`, `reload_expo`
- `logcat`
- `shell`
