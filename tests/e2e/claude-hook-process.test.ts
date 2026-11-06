import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const viteNode = resolve('node_modules/vite-node/vite-node.mjs')
const preHook = resolve('src/hooks/claude-hook.ts')

let localAppData: string

beforeEach(() => {
  localAppData = mkdtempSync(join(tmpdir(), 'agent-island-hook-process-'))
})

afterEach(() => {
  rmSync(localAppData, { recursive: true, force: true })
})

function runHook(payload: string) {
  return spawnSync(process.execPath, [viteNode, preHook], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, LOCALAPPDATA: localAppData, CLAUDE_PID: String(process.pid) },
    cwd: resolve('.')
  })
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'mirror-session',
    cwd: 'C:/repo',
    hook_event_name: 'PreToolUse',
    tool_use_id: 'tool-1',
    tool_name: 'Bash',
    tool_input: { command: 'git status --porcelain' },
    ...overrides
  })
}

/**
 * Any permissionDecision printed here overrides Claude's own policy, so the
 * only safe output from a mirror hook is none at all.
 */
describe('PreToolUse mirror hook', () => {
  it('stays silent for a read-only tool', () => {
    const result = runHook(payload({ tool_name: 'Read', tool_input: { file_path: 'README.md' } }))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('stays silent for a tool it records', () => {
    const result = runHook(payload())
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('stays silent when it cannot read the payload', () => {
    const result = runHook('not json')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
})
