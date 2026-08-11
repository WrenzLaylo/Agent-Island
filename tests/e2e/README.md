# End-to-end wrapper tests

These run the **built** wrapper (`out/main/wrapper.js`) for real — node-pty, the
output scan, the registry writes, the decision poll, the keystroke send —
against a scripted fake agent that reports exactly what it was sent.

Run `npm run build` first. A stale `out/` means these test old code.

## Why

The rest of the suite tests pure functions. That is why every wrapper bug this
project has shipped got through: the tests were written from the same
assumption as the code, so the two agreed with each other while both disagreed
with the terminal. The Hermes panel format, the Codex `Esc` that aborted the
whole turn, the duplicate raises and the answered-first race were all of that
shape.

These tests assert on the two boundaries that unit tests cannot reach:

```
fake agent prints a panel   ->  a prompt file appears, with verbatim options
a decision file is written  ->  the fake agent receives specific bytes
```

## How the fake agent is injected

Two environment variables are enough, so nothing test-shaped exists in
production code:

| Variable | Effect |
|---|---|
| `PATH` | `discoverAgents` runs `where <agent>` first and only falls back to well-known install paths when that finds nothing. A `PATH` holding just the fake shim therefore decides what gets spawned. |
| `LOCALAPPDATA` | `registryRoot()` derives from it, so sessions, prompts and decisions land in a temp directory. A test run cannot disturb a live island. |

The shim is written as a `.cmd`, matching how npm actually installs these
agents, which also keeps the `cmd.exe` launch path under test.

## Two things that are not incidental

**The wrapper is hosted in a PTY, not on pipes.** With pipes
`process.stdin.isTTY` is false and the wrapper deliberately refuses that case:
it prints "this terminal did not give the wrapper a console", skips node-pty
and execs the agent directly, so nothing is ever scanned.

**The outer host uses winpty (`useConpty: false`).** The wrapper opens a
ConPTY of its own. Nesting ConPTYs makes node-pty's console-list helper call
`AttachConsole` against a pseudoconsole it cannot attach to; it throws
`AttachConsole failed` and the wrapper dies before scanning. winpty hands out a
real console handle, so the inner ConPTY — the one under test — behaves exactly
as it does for a user.

**The fake agent sets raw mode.** Every agent it stands in for is a TUI that
reads single keypresses. In cooked mode the console line discipline holds a
bare digit until an Enter that the wrapper deliberately never sends.

## Cost

Each case spends roughly eight seconds in the wrapper's PowerShell window
handshake before the agent starts, so the file takes about 90 seconds. The
timeouts are set in the file via `vi.setConfig`, so `npm test` needs no flags.

## What this has already caught

A `.cmd` agent could not be launched at all. `buildLaunchSpec` produces
`cmd /d /s /c "<path>"`, and both spawners quoted the already-quoted argument
again, yielding `"\"<path>\""`; cmd.exe answers "is not recognized as an
internal or external command". Since npm installs its global shims as `.cmd`,
this covered the ordinary install of every agent. Fixed by having the spec
declare its own quoting (`verbatim` / `commandLine`); see
`tests/unit/launch-spec.test.ts`.
