# Adapter compatibility

| Agent | Discovery | Launch | Multi-session PTY | Island approvals |
|-------|-----------|--------|-------------------|------------------|
| Claude Code | PATH + common paths | direct `.exe` | yes | no approval bridge; complex prompts hand off to terminal |
| Codex CLI | PATH + npm shim | `.cmd` via `cmd.exe /c` | yes when found | yes for known approvals; other prompts hand off to terminal |
| Hermes Agent | PATH + hermes venv | direct `.exe` | yes | yes, plugin and known terminal prompts; other prompts hand off |

## Integration mode

Integration modes now vary by adapter:

- Claude: `terminal-basic` — interactive ConPTY terminal; plan mode and unsupported prompts can be handed to the focused terminal window
- Codex: `terminal-known` — interactive ConPTY terminal plus known command/file approvals and terminal handoff for other choices
- Hermes: terminal session plus its structured/plugin and terminal approval paths
- Demo approval UI is optional and never controls a real process

## Session rules (Phase 3)

1. Each agent has at most one PTY session.
2. Switching tabs does not kill other sessions.
3. Collapsing the island does not kill PTYs (main process owns them).
4. Restart force-kills and respawns only the active agent.
5. App quit stops all PTYs.
