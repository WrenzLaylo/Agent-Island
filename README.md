# Agent Island

Windows Dynamic-Island-style overlay for Claude Code, Codex CLI, and Hermes Agent.

## Status

Phase 1 vertical slice:

- Electron frameless always-on-top island
- Collapsed / peek / expanded / approval / success / error states
- Claude · Codex · Hermes tabs
- Safe approval guard + island state machine tests
- Agent executable discovery (no real PTY yet)
- Simulated approve/deny demo controls

Plan: `C:\Users\OASIS\.hermes\plans\2026-07-31_102742-agent-island.md`

## Requirements

- Node.js 20+
- Windows 10/11

## Setup

```bash
cd "C:/Users/OASIS/Downloads/agent-island"
npm install
npm test
npm run dev
```

## Shortcuts

- `Ctrl+Alt+Space` toggle expand/collapse
- `Ctrl+Alt+1` Claude
- `Ctrl+Alt+2` Codex
- `Ctrl+Alt+3` Hermes

## Next

1. Phase 2: node-pty + xterm.js real terminals
2. Phase 3: Claude / Hermes / Codex adapters
3. Phase 4: real approval bridge from CLI prompts
