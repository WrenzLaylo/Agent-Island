/**
 * Codex's `PermissionRequest` hook contract.
 *
 * Verified against the vendored source at
 * `.codex-source-0.146.1/codex-rs/hooks/`, not inferred:
 *
 *   events/permission_request.rs  "runs in the approval path, before guardian
 *                                  or user approval UI is shown … handlers can
 *                                  return a concrete allow/deny decision, or
 *                                  decline to decide"
 *   engine/output_parser.rs       the wire shape below
 *   core/src/mcp_tool_call_tests  a real hooks.json
 *
 * This supersedes the app-server plan for Codex. app-server cannot observe a
 * session it does not own, so it was a dead end for both the TUI and the VS
 * Code extension. A hook reaches both, because both run the same binary and
 * read the same `hooks.json`.
 */

export type CodexHookBehavior = 'allow' | 'deny'

export interface CodexHookInput {
  session_id?: string
  turn_id?: string
  cwd?: string
  tool_name?: string
  permission_mode?: string
  tool_input?: unknown
}

export interface ParsedCodexHookInput {
  sessionId: string
  cwd: string
  toolName: string
  toolInput: Record<string, unknown>
}

export function parseCodexHookInput(raw: string): ParsedCodexHookInput | null {
  try {
    const value = JSON.parse(raw.replace(/^﻿/, '')) as CodexHookInput
    // `typeof [] === 'object'`, so arrays must be excluded explicitly or a `[]`
    // payload parses into empty fields and raises a card with no command on it.
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return {
      sessionId: typeof value.session_id === 'string' ? value.session_id : '',
      cwd: typeof value.cwd === 'string' ? value.cwd : '',
      toolName: typeof value.tool_name === 'string' ? value.tool_name : '',
      toolInput:
        value.tool_input && typeof value.tool_input === 'object' && !Array.isArray(value.tool_input)
          ? (value.tool_input as Record<string, unknown>)
          : {}
    }
  } catch {
    return null
  }
}

/**
 * A one-line description of what is about to run.
 *
 * Codex passes the command as an array of tokens for shell calls — the same
 * shape app-server uses — so it is joined rather than guessed at.
 */
export function describeCodexToolCall(toolName: string, input: Record<string, unknown>): string {
  const command = input.command
  if (Array.isArray(command) && command.length > 0) {
    return command.map((part) => String(part)).join(' ')
  }
  if (typeof command === 'string' && command.length > 0) return command

  const path = input.path ?? input.file_path
  if (typeof path === 'string' && path.length > 0) return `${toolName || 'Tool'}: ${path}`

  const first = Object.values(input).find((value) => typeof value === 'string' && value.length > 0)
  return typeof first === 'string' ? `${toolName}: ${first}` : toolName || 'Tool call'
}

/**
 * Build the response.
 *
 * `null` means "no verdict" — the handler declines and Codex's own approval
 * flow continues, which is the behaviour someone gets without Agent Island.
 * Codex folds multiple handlers conservatively: any deny wins, otherwise the
 * last allow wins, otherwise no verdict.
 *
 * `updatedInput`, `updatedPermissions` and `interrupt` are rejected by the
 * parser as unsupported, so nothing here may emit them.
 */
export function codexHookResponse(behavior: CodexHookBehavior | null, message: string): string {
  if (behavior === null) {
    return JSON.stringify({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PermissionRequest' }
    })
  }
  return JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: behavior === 'deny' ? { behavior, message } : { behavior }
    }
  })
}

/** Map an island decision onto a Codex verdict. */
export function behaviorForDecision(choice: string | null | undefined): CodexHookBehavior | null {
  switch (choice) {
    case 'once':
    case 'session':
    case 'always':
      // A hook cannot persist a rule, so every grant covers this call only.
      return 'allow'
    case 'deny':
      return 'deny'
    default:
      return null
  }
}
