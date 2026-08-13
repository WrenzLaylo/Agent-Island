/**
 * Closes the record `claude-hook` opened.
 *
 * `PostToolUse` fires when a tool call returns, whichever way it went, so it is
 * the signal that the question in front of the user has been answered — or that
 * the command they were never asked about has simply finished. Either way the
 * call is no longer in flight and its card must come down.
 *
 * A TTL exists behind this (`PENDING_CALL_TTL_MS`) for the cases no event can
 * cover: a session killed mid-call, a machine that lost power. The TTL is ten
 * minutes, which is far too long to be the primary mechanism and exactly right
 * as a backstop.
 *
 * Writes nothing to stdout. `PostToolUse` can carry a decision, and this hook
 * has none to give — it is bookkeeping, not a participant.
 */
import { parseHookInput } from '../shared/claude-hook-protocol'
import { readStdin } from './bridge-client'
import { touchSession } from './mirror-store'
import { clearPendingCall, clearSessionCalls } from '../node/pending-calls'

function done(): never {
  process.exit(0)
}

function main(): void {
  const input = parseHookInput(readStdin())
  if (!input || !input.sessionId) done()

  // Proof of life, exactly as on the way in: a session whose tools are
  // returning is a session that is still there.
  touchSession(input.sessionId, input.cwd)

  /*
   * `Stop` is registered to this same script because `PostToolUse` does not
   * fire for a call that failed. Measured: `node -e "process.exit(3)"` left its
   * record open, and it was still open forty-five seconds later, where a
   * successful call is cleared within one poll. Without this, every failing
   * command becomes a card claiming Claude is waiting on a question nobody was
   * ever asked, for the ten minutes until its TTL.
   *
   * The end of a turn is the moment nothing can still be in flight, so it
   * clears the lot rather than one id.
   */
  if (input.event === 'Stop') {
    clearSessionCalls(input.sessionId)
    done()
  }

  clearPendingCall(input.sessionId, input.toolUseId)
  done()
}

try {
  main()
} catch {
  // A bug here must degrade to a card that lingers until its TTL, never to a
  // session that cannot continue.
  done()
}
