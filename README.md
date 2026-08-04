# Agent Island

Windows Dynamic-Island-style overlay for Claude Code, Codex CLI, and Hermes Agent.

## Status

**Phase 3** — multi-session adapters + real terminals:

- Always-on-top island UI (collapsed / peek / expanded / approval)
- Claude · Codex · Hermes tabs with live status
- Real ConPTY sessions via node-pty + xterm.js
- Tab switch does **not** kill other agent sessions
- Demo approvals **off by default** (peek → Demo)
- Island approvals for real CLI prompts = Phase 4 (not yet)

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
3. Click **Open terminal** / **Expand**
4. Type in the live agent TUI
5. Switch tabs — other sessions stay running
6. **Restart** only kills/respawns the active agent

Collapse keeps PTYs alive in the main process.

## Demo approvals

Optional fake permission cards for UI testing only:

1. Peek the island
2. Click **Demo**
3. Use **Approve · hermes** etc.

These do **not** control real agent processes.

## Next

1. Phase 4: real Approve/Deny bridge from CLI prompts (careful, safety-first)
2. Tray / click-through / installer polish
