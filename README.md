# Agent Island v0.2.2

Agent Island is a transparent Dynamic Island-style desktop HUD for monitoring supported coding agents and handling live approval requests without keeping a large terminal window in front of you.

## What v0.2.2 includes

- A pitch-black island surface in compact and expanded states, with no glass gradient or backdrop blur
- A plain idle pill with no logo, text, border, or glow until activity begins
- Quiet compact states for **Working**, **Attention required**, and **Resolved**
- Smooth native pill-to-panel morphing with a rounded window mask
- Dragging, magnetic left/right docking, a compact edge orb, and magnetic top-centre home snapping
- Per-monitor position and dock memory
- Detection and switching for **Claude Code**, **Codex**, and **Hermes**
- FIFO approval queue with expiry, cancellation, stale-request, and bridge-error handling
- Hermes permission choices when provided by the live request:
  - Allow once
  - Allow for this session
  - Add to permanent allowlist
  - Deny
- A second confirmation before permanent allowlisting
- Automatic return to pill mode after the final request is resolved
- First-run onboarding, system tray controls, and an in-island settings panel
- Return-home controls in Settings and the tray, plus **Ctrl/⌘ + Alt + Home**
- Native system typography using Segoe UI Variable on Windows and SF Pro/system UI fallbacks elsewhere
- Deliberate click-to-open behaviour with no hover expansion
- Automatic collapse when you click the desktop or another application
- Reduced-motion, sound, auto-expand, startup, always-on-top, and docking preferences

## Integration boundary

Agent Island can detect Claude Code and Codex and switch the visible active-agent state. **The live approval bridge is currently implemented for Hermes only.** It does not attach to a Claude Code or Codex terminal that was opened separately, and it does not intercept their native approval prompts yet.

## Hermes approval bridge

The bundled Hermes plugin communicates through:

```text
%LOCALAPPDATA%/hermes/agent-island/bridge/
├── pending/<id>.json
├── decisions/<id>.json
└── heartbeat.json
```

When Hermes requests approval, the plugin writes a pending file. Agent Island validates and displays the request, writes the selected decision, then briefly confirms the result before returning to the compact pill. If more requests are waiting, it moves directly to the next one.

Enable the plugin once:

```bash
hermes plugins enable agent-island-bridge
```

Start a new Hermes session after enabling it so the plugin loads.

## Run locally

```bash
npm install
npm run typecheck
npm test
npm run dev
```

## Main controls

- **Click the pill:** open or close the overview
- **Click outside the island:** return to the compact pill
- **Drag the pill/header:** reposition it
- **Drop near a screen edge:** dock as a compact orb
- **Drop near the top centre:** return to the original home position
- **Ctrl/⌘ + Alt + Home:** return home from anywhere
- **Click a docked orb:** restore the pill
- **Drag an orb away from the edge:** undock it
- **Agent mark:** switch between detected agents
- **Tray menu:** visibility, return home, settings, startup, idle behaviour, motion, sounds, docking, and diagnostics

## Design principle

> Pitch black in every state, clear only when work needs to be shown, and immediately out of the way when dismissed.
