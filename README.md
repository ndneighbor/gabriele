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
windowed** so the OS can composite the overlay on top. True exclusive fullscreen
can block every normal desktop window; supporting that would require a native
graphics hook/injected overlay, which this project intentionally avoids.

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

## Develop the overlay

```bash
npm run overlay:dev
```

Dev mode hot-swaps `overlay/styles.css` without reconnecting the terminal.
Changes to `overlay/index.html`, `overlay/renderer.js`, or `overlay/preload.js`
reload the overlay window. Changes to `overlay/main.js` restart Electron.

## Run (real: overlay on the gaming PC)

On the **Mac**: `npm run bridge`  (note the Mac's LAN IP, e.g. 172.20.6.188)

On the **PC**: `set GABRIELE_URL=ws://172.20.6.188:4848 && npm run overlay`

Then: launch Marathon in borderless windowed, `⌥⇧Tab` to prompt, play.

If the game runs on a non-primary monitor, set the zero-based display index:

```bash
GABRIELE_DISPLAY=1 npm run overlay
```

## Hotkey
`Option+Shift+Tab` (macOS) / `Alt+Shift+Tab` selects the prompt. Press it
again while focused to hide Gabriele. `Option+Shift+G` / `Alt+Shift+G` toggles a
click-through glance. Override with `GABRIELE_HOTKEY` and
`GABRIELE_GLANCE_HOTKEY`.

Note: on **Windows**, `Alt+Shift+Tab` is the OS reverse-window-switcher — pick a
different combo there via `GABRIELE_HOTKEY` (e.g. `Alt+Shift+G`).
