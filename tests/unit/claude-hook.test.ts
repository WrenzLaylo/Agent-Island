import { describe, expect, it } from 'vitest'
import {
  describeToolCall,
  hookResponse,
  islandIsListening,
  parseHookInput,
  permissionForDecision,
  shouldKeepWaiting,
  toolNeedsApproval
} from '../../src/shared/claude-hook-protocol'
import {
  hookIsInstalled,
  isOurs,
  withHookInstalled,
  withHookRemoved,
  toHookCommand,
  type ClaudeSettings
} from '../../src/main/agents/claude-hook-install'
import { bridgeAgentId } from '../../src/main/agents/approval-bridge'

const COMMAND = 'C:\\Users\\x\\AppData\\Roaming\\agent-island\\bin\\claude-hook.cmd'
const NOTIFY_CMD = 'C:/Users/x/AppData/Roaming/agent-island/bin/claude-notify-hook.cmd'
const SESSION_COMMAND = 'C:/Users/x/AppData/Roaming/agent-island/bin/claude-session-hook.cmd'
/** All four events install together; see `HookCommands`. */
const CMDS = { record: COMMAND, notify: NOTIFY_CMD, session: SESSION_COMMAND }

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

  it('shows the command whatever the tool calls itself', () => {
    // Windows runs shell calls through a tool named PowerShell; the name is
    // noise next to the thing being authorised.
    expect(describeToolCall('PowerShell', { command: 'Get-ChildItem -Force' })).toBe(
      'Get-ChildItem -Force'
    )
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
    const next = withHookInstalled({}, CMDS)
    expect(hookIsInstalled(next)).toBe(true)
    const entry = next.hooks?.PreToolUse?.[0].hooks?.[0]
    // Stored with forward slashes; see `toHookCommand`.
    expect(entry?.command).toBe(toHookCommand(COMMAND))
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

    const installed = withHookInstalled(theirs, CMDS)
    expect(installed.hooks?.PreToolUse).toHaveLength(2)
    expect(installed.model).toBe('opus')

    const removed = withHookRemoved(installed)
    expect(removed.hooks?.PreToolUse).toEqual(theirs.hooks?.PreToolUse)
    expect(hookIsInstalled(removed)).toBe(false)
  })

  it('is idempotent', () => {
    // Installing twice must not stack duplicates, and a changed command path
    // must replace the old entry rather than sit beside it.
    const once = withHookInstalled({}, CMDS)
    const twice = withHookInstalled(once, { ...CMDS, record: 'C:\\new\\path\\claude-hook.cmd' })
    const entries = (twice.hooks?.PreToolUse ?? []).flatMap((group) => group.hooks ?? [])
    expect(entries.filter(isOurs)).toHaveLength(1)
    expect(entries[0].command).toBe('C:/new/path/claude-hook.cmd')
  })

  it('cleans up after itself completely', () => {
    // Removing the only hook should not leave `hooks: { PreToolUse: [] }` or an
    // empty `hooks` object as litter in someone's settings file.
    const removed = withHookRemoved(withHookInstalled({}, CMDS))
    expect(removed.hooks).toBeUndefined()
  })

  it('removes nothing from settings that never had it', () => {
    const settings: ClaudeSettings = { model: 'opus', permissions: { allow: ['Bash(ls:*)'] } }
    expect(withHookRemoved(settings)).toEqual(settings)
  })

  it('matches every tool and lets the hook decide', () => {
    /*
     * Naming tools in the matcher was tried and failed: `Bash|Write|Edit|…`
     * never matched a real shell command, because on Windows the VS Code
     * extension runs them through a tool it displays as PowerShell. Every
     * command ran unannounced.
     */
    expect(withHookInstalled({}, CMDS).hooks?.PreToolUse?.at(-1)?.matcher).toBe('')
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

describe('which calls are worth raising', () => {
  it('raises anything that is not known to be read-only', () => {
    // Including tool names this build has never seen — a renamed or new shell
    // tool must not slip through silently, which is exactly what happened when
    // the matcher named tools instead.
    for (const tool of ['Bash', 'PowerShell', 'Write', 'Edit', 'WebFetch', 'SomeFutureTool']) {
      expect(toolNeedsApproval(tool)).toBe(true)
    }
  })

  it('raises Glob, which Claude really does ask about', () => {
    /*
     * Captured: Claude asked the user to approve a Glob, because the pattern
     * reached outside the allowed directory. Scope is what its permission
     * model weighs, not whether the tool reads or writes -- so filtering on
     * the verb meant that prompt never reached the island.
     */
    expect(toolNeedsApproval('Glob')).toBe(true)
    expect(toolNeedsApproval('LS')).toBe(true)
    // A subagent can do anything its parent could.
    expect(toolNeedsApproval('Task')).toBe(true)
  })

  it('answers reads and searches locally, with no card', () => {
    for (const tool of ['Read', 'Grep', 'TodoWrite', 'WebSearch']) {
      expect(toolNeedsApproval(tool)).toBe(false)
    }
  })

  it('does not raise a card for a payload with no tool name', () => {
    expect(toolNeedsApproval('')).toBe(false)
  })
})

describe('the hook command path', () => {
  const BACKSLASH = String.fromCharCode(92)
  const WINDOWS_PATH = ['C:', 'Users', 'x', 'AppData', 'Roaming', 'agent-island', 'bin', 'claude-hook.cmd'].join(
    BACKSLASH
  )

  it('writes forward slashes', () => {
    /*
     * The bug that made the whole feature look impossible. Claude Code runs
     * hook commands through a shell, which eats backslashes as escapes, so
     * `C:\Users\…\claude-hook.cmd` arrived as `C:UsersOASIS…claude-hook.cmd` —
     * a path that does not exist. The hook was configured, launched, and
     * failed silently on every tool call, which is indistinguishable from
     * Claude ignoring hooks altogether. It was mistaken for exactly that.
     */
    const written = toHookCommand(WINDOWS_PATH)
    expect(written).not.toContain(BACKSLASH)
    expect(written).toBe('C:/Users/x/AppData/Roaming/agent-island/bin/claude-hook.cmd')
  })

  it('leaves a path that is already clean alone', () => {
    expect(toHookCommand('C:/already/clean.cmd')).toBe('C:/already/clean.cmd')
  })

  it('applies it to what actually gets installed', () => {
    const entry = withHookInstalled({}, { ...CMDS, record: WINDOWS_PATH }).hooks?.PreToolUse?.at(-1)?.hooks?.[0]
    expect(entry?.command).not.toContain(BACKSLASH)
  })
})

describe('which agent a bridge request belongs to', () => {
  it('reads the surface each client sets', () => {
    /*
     * The bridge was built for the Hermes plugin and hard-coded its name, so
     * once the Claude and Codex hooks started using the same protocol, every
     * one of their requests appeared under Hermes' logo — the wrong agent
     * named on a card whose whole job is saying who is asking.
     */
    expect(bridgeAgentId('claude-hook')).toBe('claude')
    expect(bridgeAgentId('codex-hook')).toBe('codex')
  })

  it('still defaults to Hermes', () => {
    // Every existing plugin build sends something else, or nothing at all.
    expect(bridgeAgentId('hermes-plugin')).toBe('hermes')
    expect(bridgeAgentId(undefined)).toBe('hermes')
    expect(bridgeAgentId('')).toBe('hermes')
  })
})

describe('publishing the session itself', () => {
  const SESSION_CMD = 'C:/Users/x/AppData/Roaming/agent-island/bin/claude-session-hook.cmd'

  it('registers SessionStart and SessionEnd', () => {
    /*
     * Without these the island answers approvals from the VS Code extension
     * while still reading "Run island claude in a terminal to connect a
     * session" — contradicting itself on one screen.
     */
    const next = withHookInstalled({}, CMDS)
    for (const event of ['SessionStart', 'SessionEnd']) {
      const entry = next.hooks?.[event]?.at(-1)?.hooks?.[0]
      expect(entry?.command).toBe(SESSION_CMD)
      expect(isOurs(entry!)).toBe(true)
    }
  })

  it('does not make a session start wait on Agent Island', () => {
    const entry = withHookInstalled({}, CMDS).hooks?.SessionStart?.at(-1)?.hooks?.[0]
    expect(entry?.timeout).toBeLessThanOrEqual(10)
  })

  it('removes every event it wrote to', () => {
    // A SessionStart entry left behind would keep publishing sessions long
    // after the user removed the hook.
    const removed = withHookRemoved(withHookInstalled({}, CMDS))
    expect(removed.hooks).toBeUndefined()
  })

  it('leaves the user\u2019s own SessionStart hooks alone', () => {
    const theirs: ClaudeSettings = {
      hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'mine.sh' }] }] }
    }
    const removed = withHookRemoved(withHookInstalled(theirs, CMDS))
    expect(removed.hooks?.SessionStart).toEqual(theirs.hooks?.SessionStart)
  })

  it('installs every event in one pass', () => {
    /*
     * Installing PreToolUse without Notification is the failure that matters:
     * one records calls nobody reads, the other can only say "Claude needs
     * your permission" with no idea what for. They go in together or not at
     * all.
     */
    const next = withHookInstalled({}, CMDS)
    for (const event of ['PreToolUse', 'Notification', 'SessionStart', 'SessionEnd']) {
      expect(next.hooks?.[event], event).toBeDefined()
    }
  })

  it('does not let a tool call wait on Agent Island', () => {
    // The 130s allowance belonged to the version that blocked until the user
    // answered. This one writes a file and returns.
    const entry = withHookInstalled({}, CMDS).hooks?.PreToolUse?.at(-1)?.hooks?.[0]
    expect(entry?.timeout).toBeLessThanOrEqual(10)
  })
})
