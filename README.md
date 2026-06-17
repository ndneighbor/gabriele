# Durandal

An **agent-first overlay terminal**. A translucent, always-on-top HUD that floats
over your game and lets you supervise Claude Code agents in your peripheral
vision — fire a prompt with a hotkey, keep playing, watch the tile pulse when the
agent is done. Named for the Marathon AI.

```
  ┌──────────── gaming PC ────────────┐        ┌──────────── Mac ────────────┐
  │  overlay  (Electron, top-most)    │  ws    │  bridge  (Node)             │
  │   • tiles by state                │◀──────▶│   • spawns `claude` agents  │
  │   • ⌃⇧Space to prompt             │  LAN   │   • streams state back      │
  └───────────────────────────────────┘        └─────────────────────────────┘
```

The overlay is a **separate top-most window** — it never injects into or reads
the game process, so it's invisible to anti-cheat. Run your game in **borderless
windowed** so the OS can composite the overlay on top.

## Run (local test, all on one machine)

```bash
npm install
npm run bridge          # terminal 1 — the agent host
npm run overlay         # terminal 2 — the HUD
npm run send "say hi"   # terminal 3 — fire a test prompt (or use ⌃⇧Space)
```

## Run (real: overlay on the gaming PC)

On the **Mac**: `npm run bridge`  (note the Mac's LAN IP, e.g. 172.20.6.188)

On the **PC**: `set DURANDAL_URL=ws://172.20.6.188:4848 && npm run overlay`

Then: launch Marathon in borderless windowed, `⌃⇧Space` to prompt, play.

## Hotkey
`Ctrl/Cmd+Shift+Space` toggles focus mode (type a prompt). `Esc` dismisses.
Override with `DURANDAL_HOTKEY`.
