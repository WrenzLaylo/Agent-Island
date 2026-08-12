/**
 * Agent Island's Codex `PermissionRequest` hook.
 *
 * Runs inside the user's agent, in the approval path, before Codex shows its
 * own UI. Same rules as the Claude hook: never throw, never wait on an island
 * that is not there, and always leave a way for Codex to ask normally.
 *
 * Declining (no verdict) is the safe answer everywhere, because Codex then
 * continues its usual approval flow.
 */
import {
  behaviorForDecision,
  codexHookResponse,
  describeCodexToolCall,
  parseCodexHookInput
} from '../shared/codex-hook-protocol'
import { askIsland, bridgeRoot, islandAvailable, readStdin } from './bridge-client'

function answer(behavior: 'allow' | 'deny' | null, message: string): never {
  process.stdout.write(codexHookResponse(behavior, message))
  process.exit(0)
}

function main(): void {
  const input = parseCodexHookInput(readStdin())
  if (!input) answer(null, 'Agent Island could not read the hook payload')

  const root = bridgeRoot()
  // The common case when the island is not running: no waiting, no file.
  if (!islandAvailable(root)) answer(null, 'Agent Island is not running')

  const choice = askIsland(
    {
      surface: 'codex-hook',
      command: describeCodexToolCall(input.toolName, input.toolInput),
      description: input.toolName,
      cwd: input.cwd,
      sessionKey: input.sessionId
    },
    root
  )

  const behavior = behaviorForDecision(choice)
  answer(
    behavior,
    behavior === null ? 'No answer from Agent Island in time' : `Answered in Agent Island (${choice})`
  )
}

try {
  main()
} catch {
  // Nothing this file does is worth breaking a session over.
  answer(null, 'Agent Island hook failed')
}
