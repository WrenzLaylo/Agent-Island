# Handover — 2026-08-12

State of play at the end of a long session, written so the next one can start
without re-deriving anything.

## Live state on this machine

| | |
|---|---|
| Island | running, restarted on the current build |
| `~/.claude/settings.json` hooks | `SessionStart`, `SessionEnd` only — **no `PreToolUse`** |
| `~/.codex/hooks.json` | present (Codex hook installed, never verified live) |
| Tests | 338 passing |
| Working tree | clean, pushed |

`PreToolUse` is deliberately absent. It was installed, proved to work, and then
removed because it *takes* the question rather than showing it — see below.

## What was settled, with evidence

**The Claude hook works.** It failed for one reason: the command path was
written with backslashes, and Claude Code runs hook commands through a shell
that eats them as escapes. `C:\Users\…\claude-hook.cmd` arrived as
`C:UsersOASIS…claude-hook.cmd`, so it was configured, launched, and failed
silently on every tool call — indistinguishable from hooks not running at all,
which is what it was mistaken for. Fixed by `toHookCommand`, which writes
forward slashes. There is a test asserting no backslash survives.

Finding that took testing whether *any* hook fires, with a five-line hook that
only appends to a log. It fired immediately. **When something does not work,
check the mechanism runs at all before concluding the mechanism is
unavailable.**

**It reaches the VS Code extension.** Verified: a write from the extension
panel was intercepted and denied through the island.

**Notification fires for permission prompts.** Captured live:

```json
{ "hook_event_name": "Notification", "notification_type": "permission_prompt",
  "message": "Claude needs your permission", "session_id": "…", "cwd": "…" }
```

It carries **no tool name and no command**, which shapes the design below.

**Codex has a hooks system**, missed on the first pass. `PermissionRequest`
runs in the approval path before any UI and can return allow/deny or decline.
That, not app-server, is the way into Codex. app-server cannot observe a
session it does not own, and its daemon is Unix-only.

## Why PreToolUse is not installed

It is **global**, not VS Code-only. Intercepting removed the question from
terminals too, where the user previously had it in both the terminal panel and
the island. That was the actual complaint, twice over.

`PreToolUse` is strictly one-or-the-other: if the hook waits, the agent's own
dialog never appears; if it returns, the decision is given up and cannot be
taken back. There is no state where both are live.

## Next: mirror mode (task #25)

Pair two hooks so nothing is taken:

- `PreToolUse` returns `ask` **immediately** — no wait, no pre-emption — and
  records `{sessionId -> toolName, command}` to the registry.
- `Notification` with `notification_type === "permission_prompt"` raises the
  island card, using that record to say what is actually being asked.

The agent's own UI keeps the question everywhere. The island shows it with the
real command alongside. Terminals keep the dual surface they already had, where
the island can *also* answer by sending keystrokes. Intercept mode stays
available as a setting for anyone who wants island-only answering.

## Also open

- **#26** — approval cards have dead space with 2 or fewer options, which is
  now the common case because hook cards always have exactly two. Diagnosed
  from code, not yet measured: the window's measured correction only ever
  grows, so an over-estimate is never removed.
- **#14** — Hermes verified by the user; Codex dock mark and multi-monitor
  still unverified.
- Claude Code 2.1.228 is still patched by Kickbacks.ai. Codex was restored and
  Kickbacks uninstalled; the Claude extension was left alone, and its pristine
  `.vibe-ads-backup` sits beside it.

## Things that were wrong and are worth not repeating

- Three attempts to animate the agent mark — rotate, hand-drawn starburst,
  pulse. All three removed. A logo in motion reads as coming loose, and at 20px
  the detail that makes a mark recognisable is what turns to mush when it moves.
- The Claude hook matcher named tools (`Bash|Write|Edit|…`) and missed real
  shell commands, because on Windows the extension runs them through a tool it
  displays as **PowerShell**. Matchers now take everything and the hook decides.
- The read-only skip list included `Glob`, and Claude really does ask about
  globs — its permission model weighs *scope*, not whether a tool reads or
  writes.
