/**
 * Mirror half two: show the question without taking it.
 *
 * Fires on `Notification`. When Claude is asking for permission, this raises a
 * prompt against the session that `SessionStart` registered, so the island can
 * say what is being asked while the agent's own dialog stays exactly where it
 * was. Nothing is intercepted and no decision is made here.
 *
 * Written as a `handoff` prompt on purpose. The island renders those as "this
 * needs you, over there" rather than as buttons — which is the truth: the
 * question lives in the agent's UI and only the agent can answer it.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readStdin } from './bridge-client'
import { readCall, registryRoot, touchSession, wrapperOwns } from './mirror-store'

/** Long enough to outlast a decision, short enough not to linger if missed. */
const PROMPT_TTL_MS = 10 * 60_000

function done(why = ''): never {
  // Silent by default: a hook must never write to a session's stderr. Set
  // AI_HOOK_DEBUG to find out why a card did not appear.
  if (process.env.AI_HOOK_DEBUG && why) process.stderr.write(`notify-hook: ${why}\n`)
  process.exit(0)
}

function main(): void {
  let payload: {
    session_id?: string
    cwd?: string
    notification_type?: string
    message?: string
  }
  try {
    payload = JSON.parse(readStdin().replace(/^﻿/, '')) as typeof payload
  } catch {
    done('stdin was not JSON')
  }
  if (!payload || typeof payload !== 'object') done('payload was not an object')

  // Only permission prompts. Claude notifies about other things — idle
  // reminders among them — and none of those are a decision to surface.
  if (payload.notification_type !== 'permission_prompt') done(`notification_type=${payload.notification_type}`)

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
  if (!sessionId) done('no session_id')

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''
  // A wrapper already raises an answerable card for this terminal; mirroring
  // would show the same question twice, one of which cannot be acted on.
  if (wrapperOwns(cwd)) done(`a wrapper owns ${cwd}`)

  const call = readCall(sessionId)
  const now = Date.now()
  const id = `claude-hook-${sessionId}`

  /*
   * Refresh the session before raising anything against it.
   *
   * The island ignores a prompt whose session is not in the registry, and
   * greys a row whose heartbeat has gone stale. Nothing heartbeats these --
   * there is no wrapper -- and hooks only fire when Claude *acts*, so a
   * session sitting on a permission prompt is the one case guaranteed to look
   * dead. That is precisely when the card matters.
   *
   * This is the last event before the wait, so it is the freshest stamp
   * available. It does not survive a long wait; see the note in the handover.
   */
  touchSession(sessionId, cwd || call?.cwd || '')

  try {
    const dir = join(registryRoot(), 'prompts')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${id}.json`)
    const tmp = `${target}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          sessionId: id,
          agentId: 'claude',
          kind: 'handoff',
          promptId: `${id}-${now}`,
          title: payload.message || 'Claude needs your permission',
          // The recorded call is what makes this worth showing; without it the
          // card could only repeat the notification's generic sentence.
          detail: call?.command || 'Answer the prompt in Claude to continue.',
          cwd: cwd || call?.cwd || '',
          createdAt: now,
          expiresAt: now + PROMPT_TTL_MS,
          fingerprint: `${id}-${call?.command ?? ''}`
        },
        null,
        2
      ),
      'utf8'
    )
    renameSync(tmp, target)
  } catch (error) {
    // Nothing here is worth interrupting the session over.
    if (process.env.AI_HOOK_DEBUG) process.stderr.write(`notify-hook: write failed: ${String(error)}
`)
  }
  done('finished')
}

try {
  main()
} catch {
  done()
}
