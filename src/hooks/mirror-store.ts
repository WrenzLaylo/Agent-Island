/**
 * The bridge between the two halves of mirror mode.
 *
 * `Notification` tells us a permission is being asked but carries no tool name
 * and no command — verified from a live capture, it is only
 * `{ notification_type: "permission_prompt", message, session_id, cwd }`. A
 * card built from that alone could say "Claude needs your permission" and
 * nothing about what for, which is not a decision anyone can weigh.
 *
 * So `PreToolUse` writes what it saw, without blocking, and `Notification`
 * reads it back. One small file per session, overwritten each call.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface RecordedCall {
  toolName: string
  command: string
  cwd: string
  at: number
}

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

function callsDir(): string {
  return join(registryRoot(), 'calls')
}

function callPath(sessionId: string): string {
  // Session ids are uuids from Claude Code, but this is used as a filename, so
  // anything unexpected is stripped rather than trusted.
  return join(callsDir(), `${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}.json`)
}

export function recordCall(sessionId: string, call: RecordedCall): void {
  if (!sessionId) return
  try {
    mkdirSync(callsDir(), { recursive: true })
    const target = callPath(sessionId)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(call), 'utf8')
    renameSync(tmp, target)
  } catch {
    // The card degrades to a generic message; nothing is worth failing on.
  }
}

/** How stale a recorded call may be and still describe the prompt on screen. */
export const CALL_FRESH_MS = 60_000

export function readCall(sessionId: string, now = Date.now()): RecordedCall | null {
  try {
    const raw = readFileSync(callPath(sessionId), 'utf8')
    const value = JSON.parse(raw.replace(/^﻿/, '')) as RecordedCall
    if (!value || typeof value.command !== 'string') return null
    // An old record belongs to a call that has already been answered; showing
    // it would put the wrong command on the card.
    if (typeof value.at === 'number' && now - value.at > CALL_FRESH_MS) return null
    return value
  } catch {
    return null
  }
}

export function clearCall(sessionId: string): void {
  try {
    rmSync(callPath(sessionId), { force: true })
  } catch {
    // ignore
  }
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

/**
 * Whether an `island` wrapper is already watching this working directory.
 *
 * A terminal session runs the same CLI, so these hooks fire there too. The
 * wrapper's scraper already raises a card for that panel — and an *answerable*
 * one, since it can send keystrokes. Mirroring on top would show the same
 * question twice, one of which does nothing.
 *
 * Matched on cwd because the two mechanisms have no shared id: the wrapper
 * mints its own uuid, and Claude Code mints another.
 */
export function wrapperOwns(cwd: string): boolean {
  if (!cwd) return false
  const dir = join(registryRoot(), 'sessions')
  if (!existsSync(dir)) return false
  const target = cwd.replace(/[\\/]+$/, '').toLowerCase()
  try {
    for (const name of readdirSync(dir)) {
      // Sessions this app published for hook-hosted agents are not wrappers.
      if (!name.endsWith('.json') || name.startsWith('claude-hook-')) continue
      const raw = readFileSync(join(dir, name), 'utf8').replace(/^﻿/, '')
      const record = JSON.parse(raw) as { cwd?: string; agentId?: string }
      if (record?.agentId !== 'claude') continue
      if (String(record.cwd ?? '').replace(/[\\/]+$/, '').toLowerCase() === target) return true
    }
  } catch {
    // A registry we cannot read is treated as empty: mirroring twice is a
    // worse failure than not mirroring at all.
  }
  return false
}
