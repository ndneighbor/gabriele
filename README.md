# Gabriele

An **agent-first overlay terminal**. A translucent, always-on-top HUD that floats
over your game and lets you supervise Codex or bring-your-own agents in your peripheral
vision — fire a prompt with a hotkey, keep playing, watch the tile pulse when the
agent is done. Named after my brother, as we like to say: "Just tell Gabriele."

```
  ┌──────────── gaming PC ────────────┐        ┌──────────── Mac ────────────┐
  │  overlay  (Electron, top-most)    │  ws    │  bridge  (Node)             │
  │   • tiles by state                │◀──────▶│   • spawns `codex` agents   │
  │   • ⌥⇧Tab to prompt              │  LAN   │   • streams state back      │
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
npm run send "say hi"   # terminal 3 — fire a test prompt (or use ⌥⇧Tab)
```

The default agent command is `codex`. Bring your own agent by changing the bridge
command:

```bash
GABRIELE_CMD=opencode npm run bridge
GABRIELE_CMD=claude GABRIELE_ARGS='["--dangerously-skip-permissions"]' npm run bridge
```

Any command that behaves like an interactive terminal agent can run here; the
bridge is just a PTY host plus synchronized render stream.

## Run (real: overlay on the gaming PC)

On the **Mac**: `npm run bridge`  (note the Mac's LAN IP, e.g. 172.20.6.188)

On the **PC**: `set GABRIELE_URL=ws://172.20.6.188:4848 && npm run overlay`

Then: launch Marathon in borderless windowed, `⌥⇧Tab` to prompt, play.

## Hotkey
`Option+Shift+Tab` (macOS) / `Alt+Shift+Tab` toggles focus mode (type a prompt).
`Esc` dismisses. Override with `GABRIELE_HOTKEY`.

Note: on **Windows**, `Alt+Shift+Tab` is the OS reverse-window-switcher — pick a
different combo there via `GABRIELE_HOTKEY` (e.g. `Alt+Shift+G`).
