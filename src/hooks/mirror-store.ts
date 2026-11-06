/**
 * Session identity for an agent Agent Island did not launch.
 *
 * A session started by the VS Code extension has no `island` wrapper to publish
 * it or heartbeat it, so its hooks do that instead: every one of them proves the
 * session is alive and refreshes the record here. What each call *is* lives in
 * `node/pending-calls`; this module answers only "which session, and is it still
 * there".
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isSafeFileId } from '../shared/session-registry'

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
 * The `island` wrapper hosting this session, if one is.
 *
 * The wrapper exports `AGENT_ISLAND_SESSION` when it spawns the agent, and
 * Claude Code passes its own environment down to every hook it runs — so this
 * is readable from inside a hook, exactly, with no inference.
 *
 * Returns '' for a session no wrapper launched: the VS Code extension, or
 * `claude` started by hand.
 */
export function wrapperSessionId(): string {
  const value = process.env.AGENT_ISLAND_SESSION
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Whether to stand down entirely, because a wrapper owns this session.
 *
 * A wrapper is strictly better placed than these hooks: it scrapes the panel,
 * so its card carries the real choices and can be *answered*, and it knows the
 * terminal window so the card can offer a handoff. Everything a hook publishes
 * for such a session is a second, worse copy of that.
 *
 * The cost of publishing anyway was not cosmetic. The hook's card is a
 * `handoff` — it has no options by construction — and it was landing on top of
 * the wrapper's answerable one, so a CLI session that could always be answered
 * from the island started saying "Claude needs your permission" with nothing to
 * click. That is what a user means by "he broke it".
 *
 * Ownership used to be decided by comparing working directories. That looked
 * equivalent and is not: the wrapper records the directory it was *launched*
 * in, while a hook reports where the session is *now*, so a single `cd` —
 * or opening a project below home — silently separated the two records for the
 * same process. Measured: wrapper `6cf53b71` in `the home folder`, its own child
 * claude reporting `the repo folder`, pid 11064 whose
 * parent was the wrapper's 18056.
 */
export function wrapperOwnsThisSession(): boolean {
  return wrapperSessionId() !== ''
}

/**
 * The session record an agent's activity belongs to. A wrapped session already
 * has one, under the wrapper's id; otherwise the hook published its own.
 */
export function activityKey(sessionId: string): string {
  return wrapperSessionId() || `claude-hook-${sessionId}`
}

/** Advisory, like the rest of this file: it must never get in the agent's way. */
export function writeActivity(key: string, label: string): void {
  if (!isSafeFileId(key)) return
  try {
    const dir = join(registryRoot(), 'activity')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${key}.json`)
    const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`
    writeFileSync(tmp, JSON.stringify({ label, at: Date.now() }), 'utf8')
    renameSync(tmp, target)
  } catch {
    // The pill falls back to its generic status.
  }
}

export function clearActivity(key: string): void {
  if (!isSafeFileId(key)) return
  try {
    rmSync(join(registryRoot(), 'activity', `${key}.json`), { force: true })
  } catch {
    // A stale label ages out on its own.
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
  if (!isSafeFileId(sessionId)) return
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

    const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`
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
