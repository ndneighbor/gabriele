# Gabriele — Product Roadmap

**Gabriele is an agent-first cockpit.** Drive coding agents — Claude Code, Codex,
any MCP agent — from a glanceable overlay and your phone while your attention is
somewhere else (gaming, a meeting, AFK). A "less shit Warp": local, multi-session,
agent-native, floating over whatever you're doing.

## Principles (what every slice is held to)

- **Cards against bad quality** — Clear / Precise / Efficient / Durable / Delightful. Every element earns its place; no decoration.
- **Agent-first** — the unit is an *agent channel*, not a shell tab.
- **Glance > stare** — default mode is peripheral awareness; you dive in only when an agent needs you.
- **You own the pipes** — self-hosted relay, no third-party account, your logins stay yours (profiles).
- **Safe to walk away** — agents are powerful; the product must make it safe to let them run unwatched.
- **Graduate via committed demos** — every slice ships working end-to-end. No big rewrites.

## Baseline — what's already real ✅

- Real PTY multi-session terminal (bridge).
- **Stateful relay backend** — authoritative session state synced across *all* clients, phantom-free, bounded + self-evicting.
- Overlay HUD — visibility states, global hotkeys, native "agent responded" notifications.
- Phone app — channels, live terminal, handoff cards, notification feed.
- **Profiles** — per-channel login (personal vs work) on both clients.
- **Handoff MCP** (agent → your phone, agent-agnostic) + **Stop hook** (passive feed of every finished turn).
- Deployed on Railway (relay + MCP), reachable from anywhere.

---

## Phase 1 — Trust it while you're away  ✅ SHIPPED
*The unlock for daily use. The core promise is "let agents run while you do something else" — today that only works with `--dangerously-skip-permissions` (no oversight) or by watching. Make it safe to do neither.*

1. ✅ **Remote approvals** — a PreToolUse hook routes each tool to the phone (Allow/Deny); claude blocks until you decide, falls back to the normal prompt on timeout, never auto-allows. GUARD toggle on the phone creates approval-mode channels.
2. ✅ **Relay auth hardening** — signed per-device tokens, **host / control / view** roles, revocation via `GABRIELE_REVOKED`. A leaked view token can watch but every control frame is dropped. Raw secret still works (legacy).
3. ✅ **Session resume across bridge restart** — each claude channel gets a stable `--session-id`; the bridge persists the channel list and re-spawns with `--resume`, preserving profile + approval mode. A reboot no longer loses your agents.

## Phase 2 — The glance layer  ⭐ the bet
*Why this beats "a terminal on your phone." The raw TUI is wrong for a phone (the redraw garble proved it) and wrong for glancing. The real wedge is a clean, agent-native view.*

1. **Conversation view** — parse the transcript → render the agent's actual messages, actions, and diffs as a clean feed. Raw terminal becomes "expand to drive," not the default.
2. **Smart status** — a one-line summary per channel ("refactoring auth, 3 files in") instead of running/idle.
3. **Signal-only notifications** — buzz for decisions / completion / errors; suppress mid-turn noise (extends the existing settled/cooldown heuristics).

## Phase 3 — Drive it hands-free
*You're gaming; your hands are on WASD.*

1. **Voice push-to-talk** — hold a key, dictate a prompt.
2. **Quick-actions / macros** — one-tap common prompts ("run tests", "commit", "continue", "explain the error").
3. **Dispatch with context** — create a channel targeting a specific project/cwd from the phone, not just the bridge default.

## Phase 4 — The agent roster
*Lean into agent-agnostic — the handoff MCP already is.*

1. Run Claude Code + Codex + others side by side; unified roster with per-agent identity + status.
2. Route handoffs/approvals per agent.
3. "Compare" mode — same task to two agents, watch both.

## Phase 5 — Make it sharable
*Distribution, once the core is undeniable.*

1. Signed overlay `.app` / `.exe` — persistent Accessibility grant, double-click install.
2. Standalone mobile app (EAS APK + TestFlight).
3. One-command setup + **QR pairing** — scan to connect phone ↔ your relay.

---

## The one bet
If everything but one phase were cut, keep **Phase 2 (the glance layer).** Everything
else is table stakes; the conversation view + smart status + signal-only
notifications are what make Gabriele a *product* rather than a terminal mirror.

## Non-goals (kept honest)
- Not a general SSH/terminal client — it's agent-first.
- Not a team/SaaS product — no accounts, no billing, no multi-tenant. It's *yours*.
- Not Claude-only — agent-agnostic via MCP.
- Not a replacement for your editor — it's the *away-from-keyboard* surface.
