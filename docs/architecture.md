# Phase 0 / 1 notes

## Discovery (verified 2026-08-04)

| Agent  | Status    | Path / version |
|--------|-----------|----------------|
| Claude | Available | `C:\Users\OASIS\.local\bin\claude.exe` · Claude Code 2.1.221 |
| Codex  | Missing   | not on PATH / common locations |
| Hermes | Available | `...\hermes-agent\venv\Scripts\hermes.exe` · Hermes Agent v0.19.1 |

Discovery runs at app startup via `src/main/agents/discover.ts`.

## Spike goals

- [x] Scaffold Electron + React + TypeScript
- [x] Transparent always-on-top island window
- [x] State machine + approval invariants with tests (13 passing)
- [x] Simulated approval UI (expand, approve once, deny)
- [x] Agent executable discovery over preload IPC
- [x] Window resize with island mode
- [ ] node-pty ConPTY smoke with Hermes or Claude
- [ ] Transparent click-through outside pill bounds
- [ ] Installer / tray polish

## Run

```bash
cd "C:/Users/OASIS/Downloads/agent-island"
npm install
npm test
npm run dev
```

Shortcuts: `Ctrl+Alt+Space` toggle · `Ctrl+Alt+1/2/3` agent tabs

## Safety

Approve Once is gated by `canApproveRequest` in `src/shared/approval-guard.ts`.
Unknown / stale / dead-process requests cannot be approved from the island.

## Next

Phase 2: node-pty + xterm.js real terminals for Hermes, then Claude.
