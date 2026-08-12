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
