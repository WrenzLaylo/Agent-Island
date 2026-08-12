/**
 * The Claude Code `PreToolUse` hook contract.
 *
 * A hook runs before every tool call and can decide it, which is the only way
 * into a session Agent Island does not host — the VS Code extension spawns its
 * own `claude.exe` with no shell to shim and no terminal to scrape.
 *
 * The whole design is shaped by one hazard: this code runs *inside the user's
 * agent*, synchronously, before their work can continue. Anything that hangs
 * here hangs Claude Code itself. So every path out of the hook returns `ask`
 * unless the user has genuinely answered — `ask` hands control back to Claude's
 * own permission UI, which is exactly the behaviour someone gets today without
 * Agent Island installed.
 */

export type HookPermission = 'allow' | 'deny' | 'ask'

/** What Claude Code sends on stdin. Only the fields used here are typed. */
export interface HookInput {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
}

export interface ParsedHookInput {
  sessionId: string
  cwd: string
  toolName: string
  toolInput: Record<string, unknown>
}

export function parseHookInput(raw: string): ParsedHookInput | null {
  try {
    const value = JSON.parse(raw.replace(/^﻿/, '')) as HookInput
    // `typeof [] === 'object'`, so arrays have to be excluded explicitly —
    // otherwise a `[]` payload parses "successfully" into empty fields and
    // raises a card with no command on it.
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return {
      sessionId: typeof value.session_id === 'string' ? value.session_id : '',
      cwd: typeof value.cwd === 'string' ? value.cwd : '',
      toolName: typeof value.tool_name === 'string' ? value.tool_name : '',
      toolInput:
        value.tool_input && typeof value.tool_input === 'object'
          ? (value.tool_input as Record<string, unknown>)
          : {}
    }
  } catch {
    return null
  }
}

/**
 * A one-line description of what is about to happen.
 *
 * The user is being asked to authorise this, so it has to say what the tool
 * will actually do — not merely name the tool. A card reading "Bash" tells
 * nobody anything; the command is the decision.
 */
export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  const text = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')

  switch (toolName) {
    case 'Bash':
      return text('command') || 'Run a shell command'
    case 'Write':
      return `Write ${text('file_path') || 'a file'}`
    case 'Edit':
      return `Edit ${text('file_path') || 'a file'}`
    case 'NotebookEdit':
      return `Edit notebook ${text('notebook_path') || ''}`.trim()
    case 'WebFetch':
      return `Fetch ${text('url') || 'a URL'}`
    case 'WebSearch':
      return `Search the web for ${text('query') || 'something'}`
    default: {
      // An unknown tool is the common case over time, as new ones ship. Show
      // its name and whatever string argument it carries rather than refusing
      // to describe it.
      const first = Object.values(input).find((value) => typeof value === 'string' && value.length > 0)
      return typeof first === 'string' ? `${toolName}: ${first}` : toolName || 'Tool call'
    }
  }
}

/**
 * Map an island decision onto a hook permission.
 *
 * `session` and `always` both approve *this* call. Neither can be persisted
 * from here — a hook cannot add a permission rule to the user's settings, and
 * inventing one would grant something broader than they were shown. They
 * therefore behave as `allow`, and the scope the user picked is honoured only
 * as far as this call.
 */
export function permissionForDecision(choice: string | null | undefined): HookPermission {
  switch (choice) {
    case 'once':
    case 'session':
    case 'always':
      return 'allow'
    case 'deny':
      return 'deny'
    default:
      return 'ask'
  }
}

/** The exact object Claude Code expects on stdout. */
export function hookResponse(permission: HookPermission, reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: permission,
      permissionDecisionReason: reason
    }
  })
}

/**
 * Whether the island is close enough to answer.
 *
 * Read from the bridge heartbeat, so a stopped or crashed island costs the user
 * nothing: the hook returns `ask` immediately and Claude prompts as usual,
 * rather than waiting out a timeout on every single tool call.
 */
export const ISLAND_HEARTBEAT_STALE_MS = 15_000

export function islandIsListening(heartbeatAt: number | null, now: number): boolean {
  if (heartbeatAt === null || !Number.isFinite(heartbeatAt)) return false
  return now - heartbeatAt < ISLAND_HEARTBEAT_STALE_MS
}

/**
 * How long to wait for the user before handing back to Claude's own prompt.
 *
 * Long enough to read a command and decide; short enough that an island which
 * stopped responding mid-wait does not strand the session. On timeout the
 * pending file is withdrawn so the card does not outlive the question.
 */
export const HOOK_DECISION_TIMEOUT_MS = 120_000

/**
 * Whether to keep waiting for the user.
 *
 * Liveness has to be re-checked *while* waiting, not only before. Checking
 * once was a real bug: closing the island mid-session left the heartbeat
 * looking fresh for a few more seconds, so the hook committed to the full
 * two-minute wait and nothing ever answered. Every tool call after that
 * stalled for two minutes, which makes Claude Code unusable — far worse than
 * not having Agent Island at all.
 *
 * Re-checking means the wait ends shortly after the island goes away, and the
 * question goes back to Claude's own prompt where the user can answer it.
 */
export function shouldKeepWaiting(
  heartbeatAt: number | null,
  now: number,
  deadline: number
): boolean {
  if (now >= deadline) return false
  return islandIsListening(heartbeatAt, now)
}
