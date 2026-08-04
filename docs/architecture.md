# Phase 0–2 notes

## Discovery (verified 2026-08-04)

| Agent  | Status    | Path / version |
|--------|-----------|----------------|
| Claude | Available | `C:\Users\OASIS\.local\bin\claude.exe` · Claude Code 2.1.221 |
| Codex  | Missing   | not on PATH / common locations |
| Hermes | Available | `...\hermes-agent\venv\Scripts\hermes.exe` · Hermes Agent v0.19.1 |

## Phase 3 status

- [x] Adapter descriptors for Claude / Codex / Hermes
- [x] Launch specs via adapter layer (exe + cmd shim)
- [x] Multi-agent xterm host — tab switch does not dispose other terminals
- [x] PTY sessions survive tab switch and collapse
- [x] Live session status on tabs (`live · pid …`)
- [x] Demo approvals **off by default** (peek → Demo to enable)
- [x] Unit tests for adapters + launch
- [x] Real approval prompt interception for Hermes dangerous-command panels
- [x] Transparent pill without rectangular Windows smear
- [ ] Claude/Codex approval bridges
- [ ] Transparent click-through outside pill bounds
- [ ] Installer / tray polish

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
