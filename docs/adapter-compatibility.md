# Adapter compatibility

| Agent | Discovery | Launch | Multi-session PTY | Island approvals |
|-------|-----------|--------|-------------------|------------------|
| Claude Code | PATH + common paths | direct `.exe` | yes | no (Phase 4) |
| Codex CLI | PATH + npm shim | `.cmd` via `cmd.exe /c` | yes when found | no (Phase 4) |
| Hermes Agent | PATH + hermes venv | direct `.exe` | yes | no (Phase 4) |

## Integration mode

All available agents currently report `terminal-basic`:

- Full interactive ConPTY terminal in the island
- Approvals must be handled inside the agent TUI until Phase 4
- Demo approval UI is optional (`Demo` button in peek) and never controls a real process

## Session rules (Phase 3)

1. Each agent has at most one PTY session.
2. Switching tabs does not kill other sessions.
3. Collapsing the island does not kill PTYs (main process owns them).
4. Restart force-kills and respawns only the active agent.
5. App quit stops all PTYs.
