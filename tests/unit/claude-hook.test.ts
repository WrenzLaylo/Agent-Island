import { describe, expect, it } from 'vitest'
import {
  describeToolCall,
  hookResponse,
  islandIsListening,
  parseHookInput,
  permissionForDecision,
  shouldKeepWaiting
} from '../../src/shared/claude-hook-protocol'
import {
  hookIsInstalled,
  isOurs,
  withHookInstalled,
  withHookRemoved,
  type ClaudeSettings
} from '../../src/main/agents/claude-hook-install'

const COMMAND = 'C:\\Users\\x\\AppData\\Roaming\\agent-island\\bin\\claude-hook.cmd'

describe('hook input', () => {
  it('reads what Claude Code sends', () => {
    const parsed = parseHookInput(
      JSON.stringify({
        session_id: 'abc',
        cwd: 'C:\\repo',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build' }
      })
    )
    expect(parsed?.toolName).toBe('Bash')
    expect(parsed?.toolInput.command).toBe('rm -rf build')
  })

  it('returns null on anything unreadable rather than throwing', () => {
    // A throw here would surface as a broken hook inside the user's agent.
    for (const raw of ['', '{', 'null', '[]', 'not json']) {
      expect(() => parseHookInput(raw)).not.toThrow()
      expect(parseHookInput(raw)).toBeNull()
    }
  })

  it('survives a payload missing every field', () => {
    const parsed = parseHookInput('{}')
    expect(parsed).not.toBeNull()
    expect(parsed?.toolName).toBe('')
  })
})

describe('describing the call', () => {
  it('shows the command, not the tool name', () => {
    // The command is the decision; a card reading "Bash" tells nobody anything.
    expect(describeToolCall('Bash', { command: 'git push --force' })).toBe('git push --force')
  })

  it('names the file for edits and writes', () => {
    expect(describeToolCall('Write', { file_path: 'src/index.ts' })).toBe('Write src/index.ts')
    expect(describeToolCall('Edit', { file_path: 'src/index.ts' })).toBe('Edit src/index.ts')
  })

  it('still describes a tool it has never heard of', () => {
    // New tools ship over time; refusing to describe them would leave the user
    // approving a blank card.
    expect(describeToolCall('FutureTool', { target: 'production' })).toBe('FutureTool: production')
    expect(describeToolCall('FutureTool', {})).toBe('FutureTool')
  })
})

describe('decisions', () => {
  it('maps island answers onto hook permissions', () => {
    expect(permissionForDecision('once')).toBe('allow')
    expect(permissionForDecision('deny')).toBe('deny')
  })

  it('treats scoped grants as allowing only this call', () => {
    /*
     * A hook cannot write a permission rule into the user's settings, so
     * "session" and "always" cannot actually persist. They allow this call and
     * nothing more — claiming otherwise would grant something broader than the
     * user was shown.
     */
    expect(permissionForDecision('session')).toBe('allow')
    expect(permissionForDecision('always')).toBe('allow')
  })

  it('falls back to asking on anything unrecognised', () => {
    // `ask` hands control to Claude's own prompt: the behaviour someone gets
    // with Agent Island uninstalled. Every failure path must land here.
    for (const value of [null, undefined, '', 'nonsense']) {
      expect(permissionForDecision(value)).toBe('ask')
    }
  })

  it('emits the shape Claude Code expects', () => {
    const parsed = JSON.parse(hookResponse('deny', 'because'))
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe('because')
  })
})

describe('island liveness', () => {
  it('waits only when the island is actually there', () => {
    const now = 1_000_000
    expect(islandIsListening(now - 1_000, now)).toBe(true)
    expect(islandIsListening(now - 60_000, now)).toBe(false)
    // No heartbeat at all is the case where the island has never run.
    expect(islandIsListening(null, now)).toBe(false)
  })
})

describe('settings.json editing', () => {
  it('adds a marked entry', () => {
    const next = withHookInstalled({}, COMMAND)
    expect(hookIsInstalled(next)).toBe(true)
    const entry = next.hooks?.PreToolUse?.[0].hooks?.[0]
    expect(entry?.command).toBe(COMMAND)
    expect(isOurs(entry!)).toBe(true)
  })

  it('leaves the user\u2019s own hooks alone', () => {
    /*
     * The whole reason for the marker. Someone else's PreToolUse hook must
     * survive both install and uninstall untouched.
     */
    const theirs: ClaudeSettings = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'their-script.sh' }] }]
      },
      model: 'opus'
    }

    const installed = withHookInstalled(theirs, COMMAND)
    expect(installed.hooks?.PreToolUse).toHaveLength(2)
    expect(installed.model).toBe('opus')

    const removed = withHookRemoved(installed)
    expect(removed.hooks?.PreToolUse).toEqual(theirs.hooks?.PreToolUse)
    expect(hookIsInstalled(removed)).toBe(false)
  })

  it('is idempotent', () => {
    // Installing twice must not stack duplicates, and a changed command path
    // must replace the old entry rather than sit beside it.
    const once = withHookInstalled({}, COMMAND)
    const twice = withHookInstalled(once, 'C:\\new\\path\\claude-hook.cmd')
    const entries = (twice.hooks?.PreToolUse ?? []).flatMap((group) => group.hooks ?? [])
    expect(entries.filter(isOurs)).toHaveLength(1)
    expect(entries[0].command).toBe('C:\\new\\path\\claude-hook.cmd')
  })

  it('cleans up after itself completely', () => {
    // Removing the only hook should not leave `hooks: { PreToolUse: [] }` or an
    // empty `hooks` object as litter in someone's settings file.
    const removed = withHookRemoved(withHookInstalled({}, COMMAND))
    expect(removed.hooks).toBeUndefined()
  })

  it('removes nothing from settings that never had it', () => {
    const settings: ClaudeSettings = { model: 'opus', permissions: { allow: ['Bash(ls:*)'] } }
    expect(withHookRemoved(settings)).toEqual(settings)
  })

  it('matches every tool rather than a fixed list', () => {
    // A matcher list here would silently stop covering tools added later.
    expect(withHookInstalled({}, COMMAND).hooks?.PreToolUse?.at(-1)?.matcher).toBe('')
  })
})

describe('waiting for the user', () => {
  const now = 1_000_000

  it('keeps waiting while the island is alive and there is time left', () => {
    expect(shouldKeepWaiting(now - 1_000, now, now + 60_000)).toBe(true)
  })

  it('stops as soon as the island goes away', () => {
    /*
     * The bug this was written for. Liveness was checked once, before the
     * wait; closing the island left the heartbeat looking fresh for a few more
     * seconds, so the hook committed to the full two-minute timeout and
     * nothing ever answered. Every following tool call then stalled for two
     * minutes -- far worse than not having Agent Island installed.
     */
    expect(shouldKeepWaiting(now - 60_000, now, now + 60_000)).toBe(false)
    expect(shouldKeepWaiting(null, now, now + 60_000)).toBe(false)
  })

  it('stops at the deadline even with a healthy island', () => {
    expect(shouldKeepWaiting(now, now, now)).toBe(false)
    expect(shouldKeepWaiting(now, now + 1, now)).toBe(false)
  })
})
