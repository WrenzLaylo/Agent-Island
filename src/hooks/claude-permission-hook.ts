/**
 * The event that says, outright, that a permission is being asked.
 *
 * Everything before this inferred it. `Notification` knew a permission was
 * pending but not what for, and does not fire in the VS Code extension at all.
 * `PreToolUse` knew what the call was but not whether anyone would be asked
 * about it, so the island waited out a grace period and then hedged — "Claude
 * may need you" — because a permission dialog and a slow build are
 * indistinguishable from outside the agent.
 *
 * `PermissionRequest` is neither of those. Claude Code's own hook table
 * describes it as "run before permission prompt", and it is dispatched from the
 * permission engine rather than any one interface: `executePermissionRequestHooks`
 * is called both from the interactive path and from the code that sends
 * `can_use_tool` over the SDK control channel, which is the path the VS Code
 * extension uses. So it reaches every host, and it fires only when someone is
 * actually about to be asked.
 *
 * The payload is `{ hook_event_name, tool_name, tool_input, permission_suggestions? }`
 * on top of the usual session fields. Note there is no `tool_use_id` — hence
 * the per-session marker in `pending-calls`.
 *
 * **This hook does not answer.** It may: returning
 * `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
 * is honoured, including in the VS Code extension. Doing so would take the
 * question out of the agent's own UI, which is the one behaviour the user has
 * rejected twice. Emitting nothing leaves their dialog exactly where it was and
 * puts a card beside it.
 */
import { describeToolCall, parseHookInput } from '../shared/claude-hook-protocol'
import { readStdin } from './bridge-client'
import { touchSession, wrapperOwnsThisSession } from './mirror-store'
import { clearSessionCalls, markPermissionAsked } from '../node/pending-calls'

/** Silent, always. Any output here is a decision, and this hook has none. */
function done(): never {
  process.exit(0)
}

function main(): void {
  // Read first, even to stand down. Claude Code is writing this payload, and
  // exiting before it finishes hands that write a broken pipe.
  const raw = readStdin()
  // The wrapper scrapes this panel and can answer it. See `wrapperOwnsThisSession`.
  if (wrapperOwnsThisSession()) done()

  const input = parseHookInput(raw)
  if (!input || !input.sessionId) done()

  touchSession(input.sessionId, input.cwd)

  /*
   * Denial ends the question, and it ends it without a `PostToolUse` — that
   * fires only for a call that ran. Without this the card would sit there until
   * its ten-minute TTL, describing a command the user has already refused.
   */
  if (input.event === 'PermissionDenied') {
    // Denied calls never reach PostToolUse and this event has no tool_use_id.
    clearSessionCalls(input.sessionId)
    done()
  }

  markPermissionAsked(input.sessionId, {
    toolName: input.toolName,
    command: describeToolCall(input.toolName, input.toolInput)
  })
  done()
}

try {
  main()
} catch {
  // A bug here costs a card, never a session.
  done()
}
