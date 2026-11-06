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
import { isSafeFileId } from '../shared/session-registry'
import { randomUUID } from 'node:crypto'

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

export function pendingDir(sessionId: string, root = registryRoot()): string {
  if (!isSafeFileId(sessionId)) throw new Error('Invalid session id')
  return join(root, 'calls', sessionId)
}

/**
 * Set when the host told us this session is genuinely waiting on a permission.
 * Its presence lets the card skip the grace period, since there is no longer
 * anything to guess about.
 *
 * One file per session, not per call, and that is not a shortcut: a session
 * waiting on a permission dialog cannot start more work, so there is only ever
 * one outstanding at a time. It is also the only shape available — the
 * `PermissionRequest` payload carries `tool_name` and `tool_input` but no
 * `tool_use_id`, so there is no per-call key to file it under.
 */
function permissionMarker(sessionId: string, root = registryRoot()): string {
  return join(pendingDir(sessionId, root), '_permission.json')
}

/**
 * What the session is being asked about, when the host said so outright.
 *
 * `toolName` and `command` are present when the marker came from
 * `PermissionRequest`, which names the tool it is about. They are absent when it
 * came from `Notification`, whose payload is only
 * `{ notification_type, message, session_id, cwd }` — enough to know a
 * permission is pending, not enough to say what for.
 */
export interface PermissionRecord {
  at: number
  toolName?: string
  command?: string
}

function writeAtomic(target: string, body: string): void {
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, target)
}

export function writePendingCall(sessionId: string, call: PendingCall, root = registryRoot()): void {
  if (!isSafeFileId(sessionId) || !isSafeFileId(call.toolUseId)) return
  try {
    const dir = pendingDir(sessionId, root)
    mkdirSync(dir, { recursive: true })
    writeAtomic(join(dir, `${call.toolUseId}.json`), JSON.stringify(call))
  } catch {
    // A card that never appears is a worse outcome than a failed tool call, but
    // only just — and never worth failing the call over.
  }
}

export function clearPendingCall(sessionId: string, toolUseId: string, root = registryRoot()): void {
  if (!isSafeFileId(sessionId) || !isSafeFileId(toolUseId)) return
  try {
    rmSync(join(pendingDir(sessionId, root), `${toolUseId}.json`), { force: true })
  } catch {
    // The TTL is the backstop.
  }
}

export function markPermissionAsked(
  sessionId: string,
  detail: { toolName?: string; command?: string } = {},
  root = registryRoot()
): void {
  if (!isSafeFileId(sessionId)) return
  try {
    const dir = pendingDir(sessionId, root)
    mkdirSync(dir, { recursive: true })
    const record: PermissionRecord = { at: Date.now() }
    if (detail.toolName) record.toolName = detail.toolName
    if (detail.command) record.command = detail.command
    writeAtomic(permissionMarker(sessionId, root), JSON.stringify(record))
  } catch {
    // Without it the card still appears, just a grace period later.
  }
}

export function readPermission(
  sessionId: string,
  now = Date.now(),
  root = registryRoot()
): PermissionRecord | null {
  if (!isSafeFileId(sessionId)) return null
  try {
    const raw = readFileSync(permissionMarker(sessionId, root), 'utf8').replace(/^﻿/, '')
    const value = JSON.parse(raw) as PermissionRecord
    if (typeof value?.at !== 'number' || !Number.isFinite(value.at) || now - value.at >= PENDING_CALL_TTL_MS) return null
    if (value.toolName !== undefined && typeof value.toolName !== 'string') return null
    if (value.command !== undefined && typeof value.command !== 'string') return null
    return value
  } catch {
    return null
  }
}

export function permissionWasAsked(sessionId: string, now = Date.now(), root = registryRoot()): boolean {
  return readPermission(sessionId, now, root) !== null
}

/**
 * The permission is settled — answered, denied, or its turn ended.
 *
 * Kept separate from the calls themselves because the two are cleared by
 * different events: `PermissionDenied` ends the question while the call record
 * may legitimately still be open.
 */
export function clearPermission(sessionId: string, root = registryRoot()): void {
  if (!isSafeFileId(sessionId)) return
  try {
    rmSync(permissionMarker(sessionId, root), { force: true })
  } catch {
    // The TTL is the backstop.
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
  if (!isSafeFileId(sessionId)) return []
  const dir = pendingDir(sessionId, root)
  if (!existsSync(dir)) return []
  const calls: PendingCall[] = []
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') || name.startsWith('_')) continue
      try {
        const raw = readFileSync(join(dir, name), 'utf8').replace(/^﻿/, '')
        const value = JSON.parse(raw) as PendingCall
        if (
          !value ||
          !isSafeFileId(value.toolUseId) ||
          value.toolUseId !== name.slice(0, -'.json'.length) ||
          typeof value.toolName !== 'string' ||
          typeof value.command !== 'string' ||
          typeof value.cwd !== 'string' ||
          typeof value.at !== 'number' ||
          !Number.isFinite(value.at)
        ) continue
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
  if (!isSafeFileId(sessionId)) return
  try {
    rmSync(pendingDir(sessionId, root), { recursive: true, force: true })
  } catch {
    // ignore
  }
}
