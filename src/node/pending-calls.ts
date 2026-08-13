/**
 * Tool calls Claude has started and not finished.
 *
 * Mirror mode originally waited for `Notification` to say a permission was
 * being asked. That event does not fire in the VS Code extension. Measured, and
 * measured twice: the first attempt was taken while a pid bug was deleting
 * session records — and their prompt files with them — every twenty seconds, so
 * it proved nothing. Repeated after that was fixed, a real `git status
 * --porcelain` prompt produced a `PreToolUse` record at 08:55:57, a registered
 * session, and no notification of any kind.
 *
 * So the raise has to come from the events that *do* fire. `PreToolUse` opens a
 * call here and `PostToolUse` closes it, which makes the set of files in this
 * directory the set of calls currently in flight.
 *
 * One file per `tool_use_id`, not one per session. Claude runs tools in
 * parallel, so a single file per session is overwritten by whichever call
 * started last, and the first `PostToolUse` to return would clear a card
 * belonging to a call still waiting.
 *
 * What this cannot say on its own is *why* a call is in flight: a permission
 * dialog and a slow command look identical from here. That judgement belongs to
 * the island, which is the only party awake during the wait — see the grace
 * period in the session watcher.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registryRoot } from './registry-paths'

export interface PendingCall {
  /** Claude's own id for the call; the filename, and what clears it. */
  toolUseId: string
  toolName: string
  /** Human-readable rendering of the call, for the card. */
  command: string
  cwd: string
  at: number
}

/**
 * How long a call may stay open before it is treated as debris.
 *
 * A `PostToolUse` that never arrives — a killed session, a crash — would
 * otherwise leave a card up for the life of the registry.
 */
export const PENDING_CALL_TTL_MS = 10 * 60_000

/** Used as a path segment, so anything unexpected is stripped, not trusted. */
function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '')
}

export function pendingDir(sessionId: string, root = registryRoot()): string {
  return join(root, 'calls', safe(sessionId))
}

/**
 * Set when `Notification` told us this session is genuinely waiting on a
 * permission, in a host that sends it. Its presence lets the card skip the
 * grace period, since there is no longer anything to guess about.
 */
function permissionMarker(sessionId: string, root = registryRoot()): string {
  return join(pendingDir(sessionId, root), '_permission.json')
}

function writeAtomic(target: string, body: string): void {
  const tmp = `${target}.tmp`
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, target)
}

export function writePendingCall(sessionId: string, call: PendingCall, root = registryRoot()): void {
  if (!sessionId || !call.toolUseId) return
  try {
    const dir = pendingDir(sessionId, root)
    mkdirSync(dir, { recursive: true })
    writeAtomic(join(dir, `${safe(call.toolUseId)}.json`), JSON.stringify(call))
  } catch {
    // A card that never appears is a worse outcome than a failed tool call, but
    // only just — and never worth failing the call over.
  }
}

export function clearPendingCall(sessionId: string, toolUseId: string, root = registryRoot()): void {
  if (!sessionId || !toolUseId) return
  try {
    rmSync(join(pendingDir(sessionId, root), `${safe(toolUseId)}.json`), { force: true })
  } catch {
    // The TTL is the backstop.
  }
}

export function markPermissionAsked(sessionId: string, root = registryRoot()): void {
  if (!sessionId) return
  try {
    const dir = pendingDir(sessionId, root)
    mkdirSync(dir, { recursive: true })
    writeAtomic(permissionMarker(sessionId, root), JSON.stringify({ at: Date.now() }))
  } catch {
    // Without it the card still appears, just a grace period later.
  }
}

export function permissionWasAsked(sessionId: string, now = Date.now(), root = registryRoot()): boolean {
  try {
    const raw = readFileSync(permissionMarker(sessionId, root), 'utf8').replace(/^﻿/, '')
    const value = JSON.parse(raw) as { at?: number }
    return typeof value.at === 'number' && now - value.at < PENDING_CALL_TTL_MS
  } catch {
    return false
  }
}

/**
 * Every call still in flight for this session, oldest first.
 *
 * Oldest because that is the one that has been waiting longest, and so the one
 * a blocked session is most likely blocked on.
 */
export function readPendingCalls(
  sessionId: string,
  now = Date.now(),
  root = registryRoot()
): PendingCall[] {
  const dir = pendingDir(sessionId, root)
  if (!existsSync(dir)) return []
  const calls: PendingCall[] = []
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') || name.startsWith('_')) continue
      try {
        const raw = readFileSync(join(dir, name), 'utf8').replace(/^﻿/, '')
        const value = JSON.parse(raw) as PendingCall
        if (!value || typeof value.command !== 'string' || typeof value.at !== 'number') continue
        // Debris from a PostToolUse that never came.
        if (now - value.at > PENDING_CALL_TTL_MS) {
          rmSync(join(dir, name), { force: true })
          continue
        }
        calls.push(value)
      } catch {
        // A hook mid-write; the next poll catches it.
      }
    }
  } catch {
    return []
  }
  return calls.sort((a, b) => a.at - b.at)
}

/** Everything this session had open. Used when the session itself ends. */
export function clearSessionCalls(sessionId: string, root = registryRoot()): void {
  if (!sessionId) return
  try {
    rmSync(pendingDir(sessionId, root), { recursive: true, force: true })
  } catch {
    // ignore
  }
}
