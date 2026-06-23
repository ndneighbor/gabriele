# Relay auth

The relay accepts two kinds of `token` in the `hello` message:

1. The raw `GABRIELE_RELAY_SECRET` (legacy) — role from the hello (`host`, else `control`).
2. A **signed per-device token** carrying a role + device id (HMAC-SHA256 over the secret).

Both map to the same room (derived from the secret), so every device sees the same sessions.

## Roles

- `host` — the bridge. Broadcasts session state; receives clients' control frames.
- `control` — a client that can drive sessions (new / input / resize / kill / close).
- `view` — **read-only**. Receives full state + live output, but the relay drops every
  control frame — no `new`, no keystrokes. A leaked view token can watch, never act.

## Issue a token

```
GABRIELE_RELAY_SECRET=<secret> node relay/issue-token.mjs --role view --device living-room-tv
```

Paste the printed token into the device's TOKEN field instead of the raw secret. The
existing phone/overlay/bridge accept it unchanged — no client code change.

## Revoke

Add device id(s) to the relay's `GABRIELE_REVOKED` (comma-separated) and redeploy:

```
GABRIELE_REVOKED=living-room-tv,old-phone
```

Those devices' tokens are refused at the handshake. Rotating `GABRIELE_RELAY_SECRET`
invalidates **all** tokens at once.

## Posture

The raw secret is still a full-control credential — keep it on the bridge and your own
control devices. Hand out **signed tokens** for scoped, revocable access (a view token
for a shared screen, a per-device control token you can revoke if a phone is lost).
