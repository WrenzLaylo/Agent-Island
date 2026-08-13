/**
 * Says "this one really is a permission", in the hosts that tell us.
 *
 * `Notification` used to raise the card itself. It no longer does, for two
 * reasons. It does not fire in the VS Code extension at all — measured against
 * a real `git status --porcelain` prompt, with a registered session and a
 * `PreToolUse` record and no notification of any kind — so a design resting on
 * it left that host with nothing. And once the island began raising cards from
 * pending calls, a hook writing prompt files too would have been a second
 * writer racing the first over the same path.
 *
 * So it contributes the one thing it knows that nothing else does. A pending
 * call is ambiguous — a permission dialog and a slow command look identical
 * from the outside — and the island resolves that with a grace period. This
 * marker removes the ambiguity where the host is kind enough to report it, and
 * the card appears at once instead of a few seconds later.
 *
 * The payload carries no tool name and no command, verified from a live
 * capture: `{ notification_type, message, session_id, cwd }` and nothing more.
 * That is why it marks rather than describes.
 */
import { readStdin } from './bridge-client'
import { touchSession } from './mirror-store'
import { markPermissionAsked } from '../node/pending-calls'

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
  touchSession(sessionId, cwd)
  markPermissionAsked(sessionId)
  done('marked')
}

try {
  main()
} catch {
  done()
}
