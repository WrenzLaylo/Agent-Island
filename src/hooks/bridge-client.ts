/**
 * The half of a hook that talks to Agent Island.
 *
 * Shared by the Claude and Codex hooks, which differ only in the shape of what
 * they read on stdin and write on stdout. Everything about *waiting* — where
 * the files go, when to give up, how not to hang the user's agent — is the
 * same problem in both, and was worth solving once.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  HOOK_DECISION_TIMEOUT_MS,
  islandIsListening,
  shouldKeepWaiting
} from '../shared/claude-hook-protocol'

export function bridgeRoot(): string {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(local, 'agent-island', 'bridge')
}

export function readStdin(): string {
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

/** Whether the island is running at all. Checked before anything is written. */
export function islandAvailable(root = bridgeRoot()): boolean {
  return islandIsListening(heartbeatAt(root), Date.now())
}

export interface AskOptions {
  /** Agent id, used only to label the request. */
  surface: string
  /** The thing the user is being asked to authorise. */
  command: string
  description?: string
  cwd?: string
  sessionKey?: string
}

/**
 * Raise a request and block until the user answers.
 *
 * Returns the island's decision, or null if nobody answered in time — which
 * every caller must treat as "let the agent ask in its own UI".
 */
export function askIsland(options: AskOptions, root = bridgeRoot()): string | null {
  const id = `${options.surface}-${randomUUID()}`
  const target = join(root, 'pending', `${id}.json`)

  try {
    mkdirSync(join(root, 'pending'), { recursive: true })
    mkdirSync(join(root, 'decisions'), { recursive: true })
    const payload = JSON.stringify({
      id,
      command: options.command,
      description: options.description,
      cwd: options.cwd,
      sessionKey: options.sessionKey,
      surface: options.surface,
      createdAt: Date.now(),
      expiresAt: Date.now() + HOOK_DECISION_TIMEOUT_MS,
      // A hook cannot persist a permission rule, so offering a scope it cannot
      // honour would promise the user something that does not happen.
      choices: ['once', 'deny']
    })
    // Written aside and renamed: the island watches this directory, and a
    // half-written file would be read as a malformed request.
    const tmp = `${target}.tmp`
    writeFileSync(tmp, payload, 'utf8')
    renameSync(tmp, target)
  } catch {
    return null
  }

  const deadline = Date.now() + HOOK_DECISION_TIMEOUT_MS
  const decision = join(root, 'decisions', `${id}.json`)
  let choice: string | null = null

  /*
   * Liveness is re-checked on every pass, not just before the wait. Checking
   * once was a real bug: closing the island mid-session left the heartbeat
   * looking fresh for a few more seconds, so the hook committed to the full
   * two-minute timeout and nothing ever answered — every following tool call
   * stalling for two minutes, which is far worse than not having this at all.
   */
  while (shouldKeepWaiting(heartbeatAt(root), Date.now(), deadline)) {
    try {
      if (existsSync(decision)) {
        const raw = readFileSync(decision, 'utf8')
        rmSync(decision, { force: true })
        const value = JSON.parse(raw.replace(/^﻿/, '')) as { choice?: string }
        choice = typeof value.choice === 'string' ? value.choice : null
        break
      }
    } catch {
      // A partially written file; the next pass will read it whole.
    }
    // Sleep without a timer: this process exists only to wait.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120)
  }

  // Withdraw either way: answered, it is spent; unanswered, the question has
  // already gone back to the agent and the card would be a lie.
  rmSync(target, { force: true })
  return choice
}
