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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  describeToolCall,
  HOOK_DECISION_TIMEOUT_MS,
  hookResponse,
  islandIsListening,
  parseHookInput,
  permissionForDecision,
  shouldKeepWaiting
} from '../shared/claude-hook-protocol'

/** Its own bridge root, separate from the Hermes plugin's. */
function bridgeRoot(): string {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(local, 'agent-island', 'bridge')
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function heartbeatAt(root: string): number | null {
  try {
    const raw = readFileSync(join(root, 'heartbeat.json'), 'utf8')
    const value = JSON.parse(raw.replace(/^﻿/, '')) as { at?: number; updatedAt?: number }
    const at = value.at ?? value.updatedAt
    return typeof at === 'number' ? at : null
  } catch {
    return null
  }
}

function answer(permission: 'allow' | 'deny' | 'ask', reason: string): never {
  process.stdout.write(hookResponse(permission, reason))
  process.exit(0)
}

/**
 * Busy-wait on the decision file. Synchronous on purpose: the hook must block.
 *
 * The island's liveness is re-checked on every pass, not just before the wait
 * starts — see `shouldKeepWaiting`. Without that, closing the island mid-turn
 * stalls every following tool call for the full timeout.
 */
function waitForDecision(root: string, id: string, deadline: number): string | null {
  const target = join(root, 'decisions', `${id}.json`)
  while (shouldKeepWaiting(heartbeatAt(root), Date.now(), deadline)) {
    try {
      if (existsSync(target)) {
        const raw = readFileSync(target, 'utf8')
        rmSync(target, { force: true })
        const value = JSON.parse(raw.replace(/^﻿/, '')) as { choice?: string }
        return typeof value.choice === 'string' ? value.choice : null
      }
    } catch {
      // A partially written file; the next pass will read it whole.
    }
    // Sleep without a timer: this process exists only to wait.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120)
  }
  return null
}

function main(): void {
  const input = parseHookInput(readStdin())
  if (!input) answer('ask', 'Agent Island could not read the hook payload')

  const root = bridgeRoot()
  if (!islandIsListening(heartbeatAt(root), Date.now())) {
    // The common case when the island is not running. No waiting, no file.
    answer('ask', 'Agent Island is not running')
  }

  const id = `claude-hook-${randomUUID()}`
  const pendingDir = join(root, 'pending')
  const target = join(pendingDir, `${id}.json`)

  try {
    mkdirSync(pendingDir, { recursive: true })
    mkdirSync(join(root, 'decisions'), { recursive: true })
    const payload = JSON.stringify({
      id,
      command: describeToolCall(input.toolName, input.toolInput),
      description: input.toolName,
      cwd: input.cwd,
      sessionKey: input.sessionId,
      surface: 'claude-hook',
      createdAt: Date.now(),
      expiresAt: Date.now() + HOOK_DECISION_TIMEOUT_MS,
      choices: ['once', 'deny']
    })
    // Written aside and renamed: the island watches this directory, and a
    // half-written file would be read as a malformed request.
    const tmp = `${target}.tmp`
    writeFileSync(tmp, payload, 'utf8')
    renameSync(tmp, target)
  } catch {
    answer('ask', 'Agent Island could not raise the request')
  }

  const choice = waitForDecision(root, id, Date.now() + HOOK_DECISION_TIMEOUT_MS)
  // Withdraw the request either way: answered, it is spent; unanswered, the
  // question has already gone back to Claude and the card would be a lie.
  rmSync(target, { force: true })

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
