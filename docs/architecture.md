# Phase 0 / 1 notes

## Discovery

Discovery runs at app startup via `src/main/agents/discover.ts`.

It checks PATH (`where`) plus common install locations for:

- Claude Code
- Codex CLI
- Hermes Agent

Result is shown in the island peek/expanded footer.

## Spike goals remaining

- [x] Scaffold Electron + React + TypeScript
- [x] Transparent always-on-top island window
- [x] State machine + approval invariants with tests
- [x] Simulated approval UI
- [ ] node-pty ConPTY smoke with Hermes or Claude
- [ ] Transparent click-through outside pill bounds
- [ ] Installer / tray polish

## Safety

Approve Once is gated by `canApproveRequest` in `src/shared/approval-guard.ts`.
Unknown / stale / dead-process requests cannot be approved from the island.
