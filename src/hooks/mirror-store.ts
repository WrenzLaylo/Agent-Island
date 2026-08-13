/**
 * Session identity for an agent Agent Island did not launch.
 *
 * A session started by the VS Code extension has no `island` wrapper to publish
 * it or heartbeat it, so its hooks do that instead: every one of them proves the
 * session is alive and refreshes the record here. What each call *is* lives in
 * `node/pending-calls`; this module answers only "which session, and is it still
 * there".
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function registryRoot(): string {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(local, 'agent-island')
}

/**
 * The pid whose death means this session is over.
 *
 * Emphatically **not** `process.ppid`, which is what this used to record and
 * what the comments claimed was "the Claude process this hook was spawned by".
 * Claude Code runs a hook command through a shell, so the parent is a `cmd.exe`
 * that exits the instant the hook returns. Measured: a record written at
 * 20:16:48 named pid 29912, and that pid was already gone at 20:16:52.
 *
 * The consequence was not a stale row but a deleted one. The watcher reaps a
 * session whose heartbeat is stale *and* whose pid is gone, and nothing
 * heartbeats a hook-hosted session, so every one of them was removed — with its
 * prompt file — exactly `SESSION_STALE_MS` after its last tool call. Observed on
 * a 20-second cadence. That is precisely the window in which the user is reading
 * the permission dialog the card exists to mirror, which is why detection
 * "stopped when Claude was not answering": nothing stopped, the evidence was
 * being deleted on a timer.
 *
 * Walking the process tree instead would be guesswork — the chain above a hook
 * in the VS Code extension is `node -> cmd.exe -> bash -> bash -> claude.exe`,
 * five deep, and a terminal host gives a different depth. Claude Code exports
 * the agent's own pid, which costs nothing to read and is exact.
 *
 * Returns 0 when the variable is absent, which callers must read as "liveness
 * unknown", never as "dead" — that conflation is the whole bug above.
 */
export function agentPid(): number {
  const value = Number(process.env.CLAUDE_PID)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/**
 * Publish or refresh the session record for a hook-hosted session.
 *
 * Nothing heartbeats these — there is no wrapper — so a record written once
 * goes stale within seconds and the island greys the row and stops treating
 * its prompts as live. Every hook invocation is a proof of life, so every one
 * of them refreshes the timestamp.
 *
 * Also covers the ordering problem: `SessionStart` only fires for sessions
 * that began after the hooks were installed, so a conversation already open at
 * install time would never appear at all.
 */
export function touchSession(sessionId: string, cwd: string): void {
  if (!sessionId) return
  const id = `claude-hook-${sessionId}`
  try {
    const dir = join(registryRoot(), 'sessions')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${id}.json`)
    const now = Date.now()

    let startedAt = now
    let pid = agentPid()
    try {
      const existing = JSON.parse(readFileSync(target, 'utf8').replace(/^﻿/, '')) as {
        startedAt?: number
        pid?: number
      }
      if (typeof existing.startedAt === 'number') startedAt = existing.startedAt
      // An older Claude Code does not export CLAUDE_PID. A pid resolved once is
      // still better than none, so a good one already on file is never
      // downgraded to 0 by a later hook that could not read the variable.
      if (!pid && typeof existing.pid === 'number' && existing.pid > 0) pid = existing.pid
    } catch {
      // First sighting of this session.
    }

    const tmp = `${target}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          id,
          agentId: 'claude',
          // The agent itself — see `agentPid`. 0 means "could not tell", which
          // the watcher must not treat as dead.
          pid,
          // No window to raise: a webview panel is not something an outside
          // process can focus, and claiming otherwise would offer a handoff
          // that cannot work.
          hwnd: null,
          terminalKind: 'vscode',
          terminalLabel: 'Claude Code (no terminal)',
          cwd,
          startedAt,
          heartbeatAt: now,
          busy: false
        },
        null,
        2
      ),
      'utf8'
    )
    renameSync(tmp, target)
  } catch {
    // A missing row costs visibility, never the session.
  }
}
