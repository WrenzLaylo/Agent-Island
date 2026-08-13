/**
 * Mirror half one: record what is about to run, and get out of the way.
 *
 * This used to wait for the island to answer. It worked, and it was wrong.
 * `PreToolUse` runs *before* the agent's own permission UI, so a hook that
 * waits means that UI never appears — the question is taken out of the
 * terminal or the VS Code panel and exists only in the island. The user
 * reported it from both surfaces, and was right both times.
 *
 * It is also global. Intercepting for the sake of the VS Code extension took
 * the question away from terminals too, where the island could already show it
 * *and* answer it, because there it can send keystrokes.
 *
 * So this exits silently and records only what it saw. The agent
 * asks wherever it normally would; `claude-notify-hook` raises a card beside
 * it from this record. Nothing is intercepted.
 *
 * Intercepting is still the better fit for someone who wants the island to be
 * the only surface, but that should be a choice rather than the default, and
 * it is not what this file does any more.
 */
import {
  describeToolCall,
  parseHookInput,
  toolNeedsApproval
} from '../shared/claude-hook-protocol'
import { readStdin } from './bridge-client'
import { touchSession } from './mirror-store'
import { writePendingCall } from '../node/pending-calls'

function done(): never {
  // Mirror mode observes only. A permissionDecision here would override
  // Claude's native policy, including forcing prompts for safe tools.
  process.exit(0)
}

function main(): void {
  const input = parseHookInput(readStdin())
  if (!input) done()

  // Reads and searches are skipped here rather than by a matcher, so a tool
  // this build has never heard of is still recorded and still surfaces.
  if (!toolNeedsApproval(input.toolName)) done()

  // Every tool call is proof this session is alive, and the record it keeps
  // fresh is what stops the island greying the row out.
  touchSession(input.sessionId, input.cwd)

  // Opened here, closed by `claude-post-hook` when the call returns. While it
  // is open the call is either waiting for the user or still running, and the
  // island decides which — it is the only party awake during the wait.
  writePendingCall(input.sessionId, {
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    command: describeToolCall(input.toolName, input.toolInput),
    cwd: input.cwd,
    at: Date.now()
  })

  done()
}

try {
  main()
} catch {
  // A bug here must degrade to "Agent Island is not involved", never to a
  // session that cannot continue.
  done()
}
