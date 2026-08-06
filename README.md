# Agent Island

A Dynamic Island-style overlay for coding agents on Windows. It sits almost
invisible at the top of your screen, shows what **Claude Code**, **Codex** and
**Hermes** are doing in your real terminals, and lets you answer their
permission prompts without switching windows.

<!-- Add a screenshot or short capture here. -->

## What it does

- **Watches terminals you already have open.** Run `claude` as you normally
  would; the pill picks the session up.
- **Answers permission prompts.** When Claude asks *"Do you want to proceed?"*,
  the choices appear in the island — Allow once / Don't ask again / Deny — and
  your answer is typed into the real session.
- **Hands off what it should not answer.** Plan-mode menus, numbered choices,
  authentication and free-text questions get a **Continue in Terminal** button
  that restores, focuses and optionally moves that exact terminal window to the
  display the island is on. No new session is ever started.
- **Stays out of the way.** Idle it is a small black pill. It never takes
  keyboard focus, and it does not expand at all when you are already looking at
  the terminal that asked.
- Drag it anywhere, drop it near an edge to dock it as an orb, or press
  <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Home</kbd> to send it back to the top
  centre. Position is remembered per monitor.

## How it works

Windows gives no way to read another process's terminal output, so Agent Island
does not try. A small wrapper runs **inside** your real terminal instead:

```
island <agent>                     Agent Island
  ├─ resolve host window            ├─ SessionWatcher
  ├─ write sessions/<id>.json  ───► │   reads sessions + prompts
  ├─ run the agent in a pty         │   validates pid + window liveness
  ├─ scan output for prompts        │
  ├─ write prompts/<id>.json   ───► │   shows approval / "needs input"
  └─ read decisions/<id>.json  ◄─── └─ writes decisions/<id>.json
```

The wrapper pipes the agent straight through, so you get an ordinary session.
It also watches the output stream for prompts and publishes them to a file
registry under `%LOCALAPPDATA%/agent-island/`. Files rather than a socket:
either side can restart without the other losing track.

Finding *which* window hosts a session is the hard part. A shell inside Windows
Terminal owns only a 0×0 pseudo-console, and a single `WindowsTerminal.exe`
owns every one of its windows, so a pid lookup is ambiguous. The wrapper
resolves it with a title handshake: set a unique window title, find the window
now carrying it, restore the title, cache the handle.
`docs/v0.4.0-changes.md` has the details and the measurements behind them.

## Requirements

- Windows 10 or 11
- Node.js on `PATH` — the wrapper runs under Node, not Electron
- At least one of `claude`, `codex` or `hermes` installed

## Getting started

```bash
npm install
npm run build
npm start
```

Then turn on **Settings → Terminals → Shell integration**. It adds `claude`,
`codex` and `hermes` functions to your PowerShell profile, `.bashrc` and cmd's
AutoRun, so the commands you already type run through the wrapper. Open a new
terminal afterwards — shells read their profile at startup.

The shims **fail open**: if the wrapper or Node is missing, the real executable
runs instead.

Prefer not to touch your shell config? Skip it and start sessions explicitly:

```
%APPDATA%\agent-island\bin\island.cmd claude
```

To remove it later: **Settings → Terminals → Remove**, or
`electron . --remove-shims`.

## Terminal support

| Terminal | Session detected | Window raised | Correct **tab** focused |
|---|---|---|---|
| Windows Terminal | yes | yes | yes |
| PowerShell / cmd (conhost) | yes | yes | n/a — no tabs |
| Git Bash (mintty) | yes | yes | n/a — no tabs |
| VS Code integrated terminal | yes | no — it is a panel, not a window | no |

Tab focusing works because Windows Terminal exposes each tab as a UI
Automation `TabItem`. A tab cannot be identified in advance — agents rename
their tab titles constantly — so the island asks at the moment you click:
it writes a marker, the session paints it as its tab title, the island selects
the tab carrying it, and the title is restored. Verified with two sessions
sharing one window, each handoff landing on its own tab.

Run `island --whoami` in any terminal to see what it resolves there.

## Approval adapters

| Agent | How prompts are detected |
|---|---|
| Claude | permission panels parsed from the output stream |
| Codex | known command and file-change panels |
| Hermes | structured, via the bundled plugin in `plugins/agent-island-bridge` |

Only the choices an agent actually offers are answerable. Asking for a
permanent allowlist on a panel that offers a session-scoped grant is refused
rather than approximated, and session grants are never presented as permanent.

Claude and Codex adapters parse terminal output, so a future change to their
prompt wording may need a parser update.

## Development

```bash
npm run dev        # electron-vite dev
npm run typecheck  # both tsconfig projects
npm test           # vitest
```

```
src/main/         Electron main — windows, IPC, session watcher, shell shims
src/main/agents/  prompt detectors for claude / codex / hermes
src/node/         Node-only helpers shared by main and wrapper (Win32, paths)
src/preload/      contextBridge API
src/renderer/     React UI
src/shared/       contracts + island state machine (no node imports)
src/wrapper/      the `island` CLI that runs inside your terminal
```

Three conventions worth knowing before changing the UI:

- The **OS window is the only thing that animates geometry.** The renderer
  cross-fades content; it must not spring the surface as well.
- **Never put a `box-shadow` or `drop-shadow` on `.island-surface`.** It fills
  the transparent window exactly, so a shadow is composited *inside* the window
  rectangle and renders as a visible grey square.
- **Never clip the window with a native region.** `BrowserWindow.setShape()`
  has no anti-aliasing and turns every rounded corner into a staircase. CSS
  owns the silhouette.

## Status

Windows only. The window handshake, shell shims and Win32 layer have no macOS
or Linux path.

Multi-monitor handoff is implemented and reasoned about but has not been
verified on real multi-monitor hardware.
