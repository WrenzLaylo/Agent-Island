# Handover — 2026-08-13

Mirror mode works in the VS Code extension. This is what it took, what was
wrong in the previous handover, and what is still open.

## Live state on this machine

| | |
|---|---|
| Island | running on `a4e566d` |
| `~/.claude/settings.json` | `PreToolUse`, `PostToolUse`, `Stop`, `Notification`, `SessionStart`, `SessionEnd` |
| Tests | 382 passing |
| Verified on screen | a card beside a live permission dialog in the extension, naming the command |

## The bug that was hiding all the others

A hook-hosted session recorded `pid: process.ppid`, and both hooks described
that as "the Claude process this hook was spawned by". It never was. Claude Code
runs a hook command through a shell, so the parent is a `cmd.exe` that exits as
the hook returns. The real chain is five deep:

```
node (hook) -> cmd.exe -> bash -> bash -> claude.exe -> Code.exe
                  ^ process.ppid        ^ the session
```

Measured: a record written at 20:16:48 named pid 29912, and 29912 was already
gone at 20:16:52.

The consequence was not a stale row but a **deleted** one. The watcher reaps a
session whose heartbeat is stale and whose pid is gone; nothing heartbeats a
hook-hosted session; so every one was removed — with its prompt file — exactly
`SESSION_STALE_MS` after its last tool call. Observed on a 20-second cadence in
a registry poll log.

That is the "detection stops when Claude is not answering" from the last
handover. Nothing stopped. The evidence was being deleted on a timer, and the
window it vanished in is the window a user spends reading a dialog.

`CLAUDE_PID` fixes it: Claude Code exports the agent's own pid to hooks, so no
process walk is needed. The record now survives indefinitely while the session
lives — verified at 45 seconds and again at six minutes, where it used to die at
twenty.

**The previous handover's note that a dead session "disappears within seconds.
Measured at five" was measuring this bug.** The pid was always dead, so what
disappeared within seconds was every live session too.

## Notification does not fire in the VS Code extension

Measured twice. The first attempt is void — it was taken while the pid bug was
deleting prompt files every twenty seconds, so it could not have seen a card
either way. Repeated after the fix, against a real `git status --porcelain`
prompt: `PreToolUse` recorded the call at 08:55:57, the session registered
itself, and no notification arrived.

It **does** fire for a CLI session. Both were live in the registry at once, and
the difference is visible in the ancestry:

| Host | Chain above the hook | Notification |
|---|---|---|
| VS Code extension | `… -> claude.exe -> Code.exe` | no |
| Windows Terminal | `… -> claude.exe -> powershell -> WindowsTerminal.exe` | yes |

So the card is raised from the events that do fire, and `Notification` is kept
as an accelerator where a host sends it.

## How a card is raised now

`PreToolUse` opens a record, `PostToolUse` closes it, and what is left is the
set of calls in flight. The island promotes one to a card, because it is the
only party awake while a session waits.

One file per `tool_use_id` under `calls/<sessionId>/`, not one per session:
Claude runs tools in parallel, so a per-session record is overwritten by
whichever call started last, and the first `PostToolUse` back would clear a card
belonging to a call still waiting.

A call in flight is ambiguous — a permission dialog and a slow command look
identical from outside the agent. Three things resolve it:

1. **A grace period** (`CARD_GRACE_MS`, 12s). Ordinary calls return in well
   under a second.
2. **The process tree.** Claude spawns a shell per command and keeps none alive
   between calls: sampled once a second for 90 seconds, 88 samples had only
   `conhost.exe` and the two with `bash.exe` were exactly the two tool calls in
   that window. Permission is asked *before* the command runs, so a child at the
   moment the grace elapses means the user already answered. Asked once per call
   and remembered; the answer cannot change.
3. **`Notification`, where it fires.** Then there is nothing to guess and the
   card says "Claude needs your permission" instead of "Claude may need you".

`conhost.exe` is excluded by name — Windows attaches one for the life of a
console-owning process, and counting it would report every session as
permanently busy.

## PostToolUse does not fire for a failed call

Measured: `node -e "process.exit(3)"` left its record open, still open
forty-five seconds later, where a successful call clears within one poll. The
card it produced named a command that had already exited, and sat on screen
through an unrelated 34-second command.

Two signals close it, both stating something true rather than guessing:

- **Supersession.** A session waiting on a permission dialog cannot start new
  work, so a record with a later call after it was never waiting on anything.
  Only the newest burst is eligible, with a 2s window because parallel calls
  arrive milliseconds apart.
- **`Stop`.** The end of a turn is the one moment nothing can be in flight, so
  it clears the lot. Registered to the same script as `PostToolUse`.

## Open

- **A hook-registered CLI session is labelled `Claude Code (no terminal)` with
  `hwnd: null`.** `touchSession` hardcodes both. For a session under Windows
  Terminal that is wrong twice: it has a terminal, and its window could be
  raised. `CLAUDE_CODE_ENTRYPOINT` distinguishes the hosts (`claude-vscode` for
  the extension), and the island could resolve the window with the ancestry walk
  the wrapper already uses. Reported as not worth fixing; recorded because the
  record is wrong regardless of which row is being looked at.
- **A long non-shell call still raises a card.** The process-tree check only
  speaks for tools that spawn a shell. A 30-second `WebFetch` spawns nothing and
  looks exactly like a session waiting.
- **#14** — Hermes verified by the user; Codex dock mark and multi-monitor still
  unverified. The Codex `PermissionRequest` hook is installed and still never
  tested live.
- **Hermes reports itself busy while idle.** Untouched today. `busy` was changed
  to mean "the visible text changed" rather than "bytes arrived"
  (`src/wrapper/index.ts`, in `scan()`) and that is not holding. Dump the
  normalised text twice a second and diff consecutive frames; exclude whatever
  moves, the way `STATUS_LINE_RE` excludes Claude's status line.

## Things worth not repeating

- **Check the mechanism runs at all before concluding it is unavailable**, and
  check that your *measurement* is not being eaten by another bug. Both
  Notification results this session were taken with the same method; only the
  second one meant anything, because the first was taken while something else
  was deleting the evidence on a timer.
- **A five-line probe beats an hour of inference.** The process chain, the
  `CLAUDE_PID` variable, whether `SessionEnd` fires, whether a shell persists
  between calls — each was a temporary probe that answered in one tool call what
  had been guessed at for a day.
- `ELECTRON_RUN_AS_NODE=1` is exported by the VS Code extension host and leaks
  into any shell it spawns, so launching the island from a VS Code terminal
  fails with `Cannot read properties of undefined (reading 'isPackaged')` —
  Electron runs `index.js` as plain node. Clear the variable first.
- Editing `~/.claude/settings.json` is still a tray action, never automatic.
  Entries carry `_source: "agent-island"`; removal takes out exactly those.
