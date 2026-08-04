# Agent Island — approval HUD only

This is **not** an AI terminal host.

It connects to **your existing Hermes sessions** and only shows confirmation
requests (dangerous commands). Approve / Deny here answers the live Hermes
approval, then falls back to Hermes' own UI if the island is offline.

## How the bridge works

1. Hermes plugin: `%LOCALAPPDATA%/hermes/plugins/agent-island-bridge/`
2. When Hermes needs approval, the plugin writes:
   `%LOCALAPPDATA%/hermes/agent-island/bridge/pending/<id>.json`
3. Agent Island watches that folder and expands with Approve once / Deny
4. Your choice is written to:
   `%LOCALAPPDATA%/hermes/agent-island/bridge/decisions/<id>.json`
5. Hermes reads the decision and continues

## Setup

```bash
cd "C:/Users/OASIS/Downloads/agent-island"
npm install
npm test
npm run dev
```

Enable the Hermes plugin (once):

```bash
hermes plugins enable agent-island-bridge
```

Then **start a new Hermes session** (plugin loads at session start).

## UX

- Collapsed pill at top of screen
- **Drag** using the left grip handle
- **Click** pill to open status
- **Hover 1 second** to open status (not instant)
- Badge pulses when confirmation is waiting
- No embedded terminal / no second AI

## Claude / Codex

Not bridged yet. Hermes first.
