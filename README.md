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

- Glassy Dynamic Island-style pill that floats above your desktop
- **Drag anywhere on the pill or header** to reposition it
- Drop it against the **left or right edge** to morph it into a compact orb
- **Click** or hover briefly to open the live bridge status
- Approval requests automatically expand the island, bring it forward, and trigger an amber attention glow
- Approve or deny directly from the expanded island
- Framer Motion powers the morphing, spring transitions, and approval feedback
- No embedded terminal / no second AI

## Claude / Codex

Not bridged yet. Hermes first.
