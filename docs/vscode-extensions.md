# The Claude and Codex VS Code extensions

Task #17. What follows is read out of the installed extensions on this
machine, not inferred:

- `anthropic.claude-code-2.1.227-win32-x64`
- `openai.chatgpt-26.803.61601-win32-x64`

## Why the shims cannot reach either of them

Agent Island's shell shims work by shadowing `claude` / `codex` as shell
functions, so a command the user types goes through the `island` wrapper
instead. Neither extension types a command.

The Claude extension resolves **its own** binary rather than one from `PATH`:

```js
let t = process.platform === "win32" ? "claude.exe" : "claude",
    r = musl() ? `${process.arch}-musl` : process.arch, …
```

and drives it headlessly — the flags present in `extension.js` are
`--output-format`, `--input-format`, `--permission-mode`, `--mcp-config` and
`--settings`. That is the streaming SDK mode: the extension owns the
conversation and renders approvals in its own webview.

So there is no shell to hook, no PATH entry to shadow, and no terminal to
scrape. A `spawn()` of an absolute path cannot be intercepted by anything the
island installs today.

## What can reach them

**Claude: `PreToolUse` hooks.** The extension still runs the real CLI, and the
CLI still reads the user's `~/.claude/settings.json`. A `PreToolUse` hook fires
before every tool call and can return a decision, so the path is the same shape
as the Hermes bridge already in this repo:

```
hook fires  ->  write a prompt file  ->  poll for a decision file
            ->  return allow / deny
```

The hook blocks while it polls, which is exactly the behaviour needed: the tool
call waits for the user, wherever they answer it.

Two things to establish before building this:

1. `--settings` appears nine times in the extension bundle. It supplies an
   additional settings layer; user-level settings are still expected to load,
   but that must be **verified**, not assumed — if the extension's layer
   replaced the user's, no hook would ever fire.
2. The extension renders its own approval UI. A hook that answers on the user's
   behalf pre-empts that dialog, so the two must not both be live, or the same
   decision gets asked twice.

**Codex: the `PermissionRequest` hook.** Not app-server, which was the first
answer here and the wrong one — the extension owns that connection and nothing
can intercept it. Codex has a hooks system (`codex-rs/hooks/`) whose
`PermissionRequest` event runs in the approval path before any UI is shown and
can return allow/deny or decline. Declared in `$CODEX_HOME/hooks.json`, so it
reaches the extension and the TUI alike.

app-server remains the right reference for what those decisions *mean* — see
`docs/codex-app-server.md` for the full `ReviewDecision` vocabulary — but it is
not the way in. The extension owns its app-server connection; nothing outside
can join it.

## Status

Both agents are reached by hooks rather than by protocol clients:

| Agent | Event | Declared in |
|---|---|---|
| Claude | `PreToolUse` | `~/.claude/settings.json` |
| Codex | `PermissionRequest` | `$CODEX_HOME/hooks.json` |

Neither installs automatically -- each edits a config file the user's agent
depends on, so both are tray actions.

### The bug that made this look impossible

Claude Code runs hook commands **through a shell**, which treats backslashes as
escape characters. A path written the Windows way, `C:\Users\me\AppData\Roaming\agent-island\bin\claude-hook.cmd`,
arrives as `C:UsersmeAppDataRoamingagent-islandbinclaude-hook.cmd` -- a path
that does not exist.

The hook is then configured, launched, and fails silently on every tool call.
That is indistinguishable from Claude ignoring hooks altogether, and it was
mistaken for exactly that: the feature was declared impossible and removed
before the real cause was found.

What found it was testing the thing that had not been tested -- whether *any*
hook fires. A minimal hook that only appends to a log fired immediately, and
the only meaningful difference between it and ours was the path separator.

`toHookCommand` now writes forward slashes, which Windows accepts everywhere
that matters and a shell leaves alone. A test asserts the installed command
contains no backslash at all.

The lesson generalises: when something does not work, check that the mechanism
runs at all before concluding the mechanism is unavailable.

### Still to verify

The VS Code extension specifically. The hook is confirmed firing for a CLI
session; whether the extension's `--settings` layer admits user-level hooks is
a separate question, and the earlier negative result was taken with the broken
path, so it proves nothing either way.

The Codex hook is likewise untested in a live session.
