# Phase 0–2 notes

## Discovery (verified 2026-08-04)

| Agent  | Status    | Path / version |
|--------|-----------|----------------|
| Claude | Available | `C:\Users\OASIS\.local\bin\claude.exe` · Claude Code 2.1.221 |
| Codex  | Missing   | not on PATH / common locations |
| Hermes | Available | `...\hermes-agent\venv\Scripts\hermes.exe` · Hermes Agent v0.19.1 |

## Phase 2 status

- [x] node-pty ConPTY works inside Electron without rebuild (N-API prebuild)
- [x] PtyManager start/write/resize/stop + replay buffer
- [x] Typed IPC: `pty:start|write|resize|stop|list|replay` + `pty:data|exit` events
- [x] xterm.js TerminalPanel in expanded island
- [x] Lazy start on Expand / Open terminal
- [x] Restart button + orphan cleanup on quit
- [x] Unit tests (20) + headless Hermes PTY smoke (`npm run smoke:pty` / `scripts/smoke-hermes-pty.cjs`)
- [ ] Transparent click-through outside pill bounds
- [ ] Installer / tray polish
- [ ] Real approval prompt interception (Phase 4)

## Run

```bash
cd "C:/Users/OASIS/Downloads/agent-island"
npm install
npm test
npm run smoke:pty
npx electron scripts/smoke-hermes-pty.cjs
npm run dev
```

Shortcuts: `Ctrl+Alt+Space` toggle · `Ctrl+Alt+1/2/3` agent tabs

In the island: click pill → **Open terminal** / **Expand** → real Hermes or Claude PTY.

## Safety

Approve Once is still simulated (demo controls). Real CLI approval bridge is Phase 4.
PTY write payloads are capped; IPC validates agent ids and sizes.

## Next

Phase 3 polish adapters + keep multi-session alive while collapsed.
Phase 4 approval bridge from terminal-known prompts.
