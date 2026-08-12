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
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readStdin } from './bridge-client'
import { readCall, registryRoot, wrapperOwns } from './mirror-store'

/** Long enough to outlast a decision, short enough not to linger if missed. */
const PROMPT_TTL_MS = 10 * 60_000

function done(): never {
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
    done()
  }
  if (!payload || typeof payload !== 'object') done()

  // Only permission prompts. Claude notifies about other things — idle
  // reminders among them — and none of those are a decision to surface.
  if (payload.notification_type !== 'permission_prompt') done()

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
  if (!sessionId) done()

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''
  // A wrapper already raises an answerable card for this terminal; mirroring
  // would show the same question twice, one of which cannot be acted on.
  if (wrapperOwns(cwd)) done()

  const call = readCall(sessionId)
  const now = Date.now()
  const id = `claude-hook-${sessionId}`

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
  } catch {
    // Nothing here is worth interrupting the session over.
  }
  done()
}

try {
  main()
} catch {
  done()
}
