import { describe, expect, it } from 'vitest'
import {
  behaviorForDecision,
  codexHookResponse,
  describeCodexToolCall,
  parseCodexHookInput
} from '../../src/shared/codex-hook-protocol'
import {
  codexHookIsInstalled,
  isOurs,
  withCodexHookInstalled,
  withCodexHookRemoved,
  CODEX_HOOK_TIMEOUT_SEC,
  toHookCommand,
  type CodexHooksFile
} from '../../src/main/agents/codex-hook-install'

const COMMAND = 'C:\\Users\\x\\AppData\\Roaming\\agent-island\\bin\\codex-hook.cmd'

describe('codex hook payload', () => {
  it('reads a permission request', () => {
    const parsed = parseCodexHookInput(
      JSON.stringify({
        session_id: 'thr_1',
        turn_id: 't1',
        cwd: 'C:\\repo',
        tool_name: 'shell',
        permission_mode: 'on-request',
        tool_input: { command: ['git', 'push', '--force'] }
      })
    )
    expect(parsed?.toolName).toBe('shell')
    expect(parsed?.cwd).toBe('C:\\repo')
  })

  it('never throws on junk', () => {
    for (const raw of ['', '{', 'null', '[]', 'nope']) {
      expect(() => parseCodexHookInput(raw)).not.toThrow()
      expect(parseCodexHookInput(raw)).toBeNull()
    }
  })

  it('joins the command tokens Codex sends', () => {
    // Codex passes shell commands as an array, the same shape app-server uses.
    expect(describeCodexToolCall('shell', { command: ['git', 'push', '--force'] })).toBe(
      'git push --force'
    )
  })

  it('still describes a tool with no command array', () => {
    expect(describeCodexToolCall('apply_patch', { path: 'src/a.ts' })).toBe('apply_patch: src/a.ts')
    expect(describeCodexToolCall('mystery', {})).toBe('mystery')
  })
})

describe('codex verdict', () => {
  it('emits the wire shape the parser accepts', () => {
    const allow = JSON.parse(codexHookResponse('allow', 'ok'))
    expect(allow.continue).toBe(true)
    expect(allow.hookSpecificOutput.hookEventName).toBe('PermissionRequest')
    expect(allow.hookSpecificOutput.decision.behavior).toBe('allow')

    const deny = JSON.parse(codexHookResponse('deny', 'user refused'))
    expect(deny.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'user refused' })
  })

  it('declines with no decision at all', () => {
    /*
     * "No verdict" is the safe answer: Codex continues its own approval flow,
     * which is what happens without Agent Island installed. Emitting a
     * decision here would answer on the user's behalf.
     */
    const parsed = JSON.parse(codexHookResponse(null, 'not running'))
    expect(parsed.hookSpecificOutput.decision).toBeUndefined()
    expect(parsed.continue).toBe(true)
  })

  it('never emits the fields Codex rejects', () => {
    // output_parser.rs refuses updatedInput, updatedPermissions and interrupt.
    for (const behavior of ['allow', 'deny', null] as const) {
      const raw = codexHookResponse(behavior, 'x')
      expect(raw).not.toContain('updatedInput')
      expect(raw).not.toContain('updatedPermissions')
      expect(raw).not.toContain('interrupt')
    }
  })

  it('maps island answers, and declines on anything else', () => {
    expect(behaviorForDecision('once')).toBe('allow')
    expect(behaviorForDecision('deny')).toBe('deny')
    // A hook cannot persist a rule, so scoped grants cover this call only.
    expect(behaviorForDecision('always')).toBe('allow')
    for (const value of [null, undefined, '', 'weird']) expect(behaviorForDecision(value)).toBeNull()
  })
})

describe('hooks.json editing', () => {
  it('writes the shape Codex reads', () => {
    const next = withCodexHookInstalled({}, COMMAND)
    const group = next.hooks?.PermissionRequest?.[0]
    expect(group?.matcher).toBe('')
    // Stored with forward slashes; a shell would eat the backslashes.
    expect(group?.hooks?.[0]).toMatchObject({ type: 'command', command: toHookCommand(COMMAND) })
    expect(codexHookIsInstalled(next)).toBe(true)
  })

  it('allows Codex longer than the hook waits', () => {
    // Otherwise Codex kills the handler mid-question and the user is left with
    // a card that can no longer be answered.
    expect(CODEX_HOOK_TIMEOUT_SEC).toBeGreaterThan(120)
  })

  it('leaves other hooks untouched through install and removal', () => {
    const theirs: CodexHooksFile = {
      hooks: {
        PermissionRequest: [
          { matcher: 'shell', hooks: [{ type: 'command', command: 'theirs.sh' }] }
        ],
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'other.sh' }] }]
      }
    }
    const installed = withCodexHookInstalled(theirs, COMMAND)
    expect(installed.hooks?.PermissionRequest).toHaveLength(2)
    expect(installed.hooks?.PreToolUse).toEqual(theirs.hooks?.PreToolUse)

    const removed = withCodexHookRemoved(installed)
    expect(removed).toEqual(theirs)
  })

  it('is idempotent across a changed path', () => {
    const once = withCodexHookInstalled({}, COMMAND)
    const twice = withCodexHookInstalled(once, 'C:\\new\\codex-hook.cmd')
    const entries = (twice.hooks?.PermissionRequest ?? []).flatMap((group) => group.hooks ?? [])
    expect(entries.filter(isOurs)).toHaveLength(1)
  })

  it('leaves no empty scaffolding behind', () => {
    expect(withCodexHookRemoved(withCodexHookInstalled({}, COMMAND)).hooks).toBeUndefined()
  })
})
