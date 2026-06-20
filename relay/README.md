# Gabriele relay

A protocol-dumb WebSocket relay (Elixir / Bandit / PubSub). Both the Mac **bridge**
(host) and the PC **overlay** (client) dial *out* to this relay — nothing inbound
on either machine, no VPN, works behind any NAT.

```
  Mac bridge ──out──▶  relay  ◀──out── PC overlay / phone
   role: host          rooms          role: client
```

- First message authenticates: `{"type":"hello","role":"host"|"client","token":"<secret>"}`.
- `token` must equal `GABRIELE_RELAY_SECRET`. The room is derived from the token,
  so the same secret = the same room.
- After auth the relay pipes raw text: **host → all clients**, **client → host**.
  It injects only `host_up` / `host_down` so clients know if the bridge is live.

## Env
- `PORT` — listen port (Railway sets this; default 4000)
- `GABRIELE_RELAY_SECRET` — the shared secret (set the same value on bridge + overlay)

## Run locally
```bash
mix deps.get
GABRIELE_RELAY_SECRET=dev-secret PORT=4000 mix run --no-halt
# ws endpoint: ws://localhost:4000/ws   ·   health: http://localhost:4000/healthz
```

## Deploy (Railway)
Point a Railway service at this directory, set `GABRIELE_RELAY_SECRET`, deploy.
The public URL becomes `wss://<service>.up.railway.app/ws`.
