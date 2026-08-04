# Agent Island

Windows Dynamic-Island-style overlay for Claude Code, Codex CLI, and Hermes Agent.

## Status

Phase 2 vertical slice:

- Electron frameless always-on-top island
- Claude · Codex · Hermes tabs
- Real ConPTY sessions via node-pty
- xterm.js terminal in expanded mode
- Safe approval guard + simulated approve/deny demo
- Agent executable discovery

Plan: `C:\Users\OASIS\.hermes\plans\2026-07-31_102742-agent-island.md`

## Requirements

- Node.js 20+
- Windows 10/11

## Setup

```bash
cd "C:/Users/OASIS/Downloads/agent-island"
npm install
npm test
npm run smoke:pty
npx electron scripts/smoke-hermes-pty.cjs
npm run dev
```

## Shortcuts

- `Ctrl+Alt+Space` toggle expand/collapse
- `Ctrl+Alt+1` Claude
- `Ctrl+Alt+2` Codex
- `Ctrl+Alt+3` Hermes

## Using real terminals

1. Open the island pill
2. Select Hermes or Claude
3. Click **Open terminal** or **Expand**
4. Type in the xterm panel (real agent process)
5. **Restart** kills and respawns that agent PTY

Sessions stay alive when you collapse the island (process keeps running in main).

## Next

1. Phase 3: stronger adapter status + multi-session UX polish
2. Phase 4: real approval bridge from CLI prompts
3. Installer / tray / click-through polish
