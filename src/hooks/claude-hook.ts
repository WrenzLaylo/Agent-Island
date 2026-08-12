/**
 * Agent Island's Claude Code `PreToolUse` hook.
 *
 * Runs inside the user's agent, synchronously, before their work continues.
 * That single fact governs everything here:
 *
 *  - it never throws — every failure path writes `ask` and exits 0, so a bug
 *    in this file degrades to "Agent Island is not involved" rather than
 *    breaking Claude Code;
 *  - it returns immediately unless the island is actually listening, so an
 *    island that is closed or crashed costs nothing per tool call;
 *  - it withdraws its request on timeout, so a card never outlives the
 *    question it was asking.
 *
 * Talks to the island over the same file bridge the Hermes plugin uses: a
 * pending file goes in, a decision file comes back.
 */
import {
  describeToolCall,
  hookResponse,
  parseHookInput,
  permissionForDecision,
  toolNeedsApproval
} from '../shared/claude-hook-protocol'
import { askIsland, bridgeRoot, islandAvailable, readStdin } from './bridge-client'

function answer(permission: 'allow' | 'deny' | 'ask', reason: string): never {
  process.stdout.write(hookResponse(permission, reason))
  process.exit(0)
}

function main(): void {
  const input = parseHookInput(readStdin())
  if (!input) answer('ask', 'Agent Island could not read the hook payload')

  // Reads and searches are decided here rather than by a matcher, so a tool
  // this build has never heard of still reaches the user.
  if (!toolNeedsApproval(input.toolName)) answer('ask', 'Read-only tool')

  const root = bridgeRoot()
  // The common case when the island is not running: no waiting, no file.
  if (!islandAvailable(root)) answer('ask', 'Agent Island is not running')

  const choice = askIsland(
    {
      surface: 'claude-hook',
      command: describeToolCall(input.toolName, input.toolInput),
      description: input.toolName,
      cwd: input.cwd,
      sessionKey: input.sessionId
    },
    root
  )

  const permission = permissionForDecision(choice)
  answer(
    permission,
    permission === 'ask' ? 'No answer from Agent Island in time' : `Answered in Agent Island (${choice})`
  )
}

try {
  main()
} catch {
  // Belt and braces. Nothing this file does is worth breaking a session over.
  answer('ask', 'Agent Island hook failed')
}
