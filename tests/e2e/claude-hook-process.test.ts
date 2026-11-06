import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const viteNode = resolve('node_modules/vite-node/vite-node.mjs')
const preHook = resolve('src/hooks/claude-hook.ts')
const permissionHook = resolve('src/hooks/claude-permission-hook.ts')
const postHook = resolve('src/hooks/claude-post-hook.ts')
const sessionHook = resolve('src/hooks/claude-session-hook.ts')
const notifyHook = resolve('src/hooks/claude-notify-hook.ts')

let localAppData: string

beforeEach(() => {
  localAppData = mkdtempSync(join(tmpdir(), 'agent-island-hook-process-'))
})

afterEach(() => {
  rmSync(localAppData, { recursive: true, force: true })
})

function runHook(script: string, payload: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCALAPPDATA: localAppData,
    CLAUDE_PID: String(process.pid),
    ...extraEnv
  }
  delete env.AGENT_ISLAND_SESSION
  if (extraEnv.AGENT_ISLAND_SESSION) env.AGENT_ISLAND_SESSION = extraEnv.AGENT_ISLAND_SESSION
  return spawnSync(process.execPath, [viteNode, script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
    cwd: resolve('.')
  })
}

function payload(event: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'vscode-session',
    cwd: 'C:/repo',
    hook_event_name: event,
    tool_use_id: 'tool-1',
    tool_name: 'Bash',
    tool_input: { command: 'git status --porcelain' },
    ...overrides
  }
}

function callsDir() {
  return join(localAppData, 'agent-island', 'calls', 'vscode-session')
}

describe('Claude mirror hook processes', () => {
  it('does not override Claude permission policy for read-only tools', () => {
    const result = runHook(preHook, payload('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'README.md' } }))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(join(callsDir(), 'tool-1.json'))).toBe(false)
  })

  it('records a relevant call without forcing Claude to ask', () => {
    const result = runHook(preHook, payload('PreToolUse'))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(JSON.parse(readFileSync(join(callsDir(), 'tool-1.json'), 'utf8')).command).toBe(
      'git status --porcelain'
    )
  })

  it('stands down silently when a wrapper owns the session', () => {
    const result = runHook(preHook, payload('PreToolUse'), { AGENT_ISLAND_SESSION: 'wrapper-session' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(callsDir())).toBe(false)
  })

  // Claude Code writes the whole payload to the hook. A hook that exits first
  // leaves that write with a broken pipe, in every wrapped session, on every call.
  it.each([
    ['PreToolUse', preHook],
    ['PostToolUse', postHook],
    ['PermissionRequest', permissionHook],
    ['SessionStart', sessionHook],
    ['Notification', notifyHook]
  ])('reads all of a large %s payload before standing down', (event, script) => {
    const big = payload(event, { tool_input: { command: 'x'.repeat(1_000_000) } })
    const result = runHook(script, big, { AGENT_ISLAND_SESSION: 'wrapper-session' })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('refuses a session id that would escape the sessions folder', () => {
    const result = runHook(sessionHook, payload('SessionStart', { session_id: 'x/../../escaped' }))
    expect(result.status).toBe(0)
    expect(existsSync(join(localAppData, 'agent-island', 'escaped.json'))).toBe(false)
  })

  it.each(['PostToolUse', 'PostToolUseFailure'])(
    'clears both the call and permission marker on %s',
    (event) => {
      expect(runHook(preHook, payload('PreToolUse')).status).toBe(0)
      expect(runHook(permissionHook, payload('PermissionRequest')).status).toBe(0)
      expect(existsSync(join(callsDir(), 'tool-1.json'))).toBe(true)
      expect(existsSync(join(callsDir(), '_permission.json'))).toBe(true)

      expect(runHook(postHook, payload(event)).status).toBe(0)
      expect(existsSync(join(callsDir(), 'tool-1.json'))).toBe(false)
      expect(existsSync(join(callsDir(), '_permission.json'))).toBe(false)
    }
  )

  it('clears the blocked call when PermissionDenied has no tool_use_id', () => {
    expect(runHook(preHook, payload('PreToolUse')).status).toBe(0)
    expect(runHook(permissionHook, payload('PermissionRequest')).status).toBe(0)

    const denied = payload('PermissionDenied')
    delete denied.tool_use_id
    expect(runHook(permissionHook, denied).status).toBe(0)
    expect(existsSync(callsDir())).toBe(false)
  })
})
