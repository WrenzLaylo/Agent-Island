import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearPendingCall,
  clearSessionCalls,
  markPermissionAsked,
  permissionWasAsked,
  readPendingCalls,
  writePendingCall,
  PENDING_CALL_TTL_MS,
  type PendingCall
} from '../../src/node/pending-calls'
import {
  CARD_GRACE_MS,
  hookCardFor,
  wrapperOwnsCwd
} from '../../src/main/agents/session-watcher'
import { childrenMeanBusy } from '../../src/node/win32-windows'
import type { AgentSessionRecord } from '../../src/shared/session-registry'

let root: string
const SESSION = 'f052512b-276f-4aa4-801c-5b72abe7936c'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-island-calls-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function call(overrides: Partial<PendingCall> = {}): PendingCall {
  return {
    toolUseId: 'toolu_1',
    toolName: 'Bash',
    command: 'git status --porcelain',
    cwd: 'C:\\repo',
    at: Date.now(),
    ...overrides
  }
}

describe('calls in flight', () => {
  it('remembers a call until it is cleared', () => {
    writePendingCall(SESSION, call(), root)
    expect(readPendingCalls(SESSION, Date.now(), root)).toHaveLength(1)
    clearPendingCall(SESSION, 'toolu_1', root)
    expect(readPendingCalls(SESSION, Date.now(), root)).toHaveLength(0)
  })

  it('keeps parallel calls apart', () => {
    /*
     * The reason this is a directory and not one file per session. Claude runs
     * tools in parallel, so a single record is overwritten by whichever call
     * started last — and the first PostToolUse to return would then clear a
     * card belonging to a call still waiting.
     */
    writePendingCall(SESSION, call({ toolUseId: 'toolu_1', command: 'npm test' }), root)
    writePendingCall(SESSION, call({ toolUseId: 'toolu_2', command: 'rm -rf build' }), root)
    expect(readPendingCalls(SESSION, Date.now(), root)).toHaveLength(2)

    clearPendingCall(SESSION, 'toolu_1', root)
    const left = readPendingCalls(SESSION, Date.now(), root)
    expect(left).toHaveLength(1)
    expect(left[0].command).toBe('rm -rf build')
  })

  it('returns the longest-waiting call first', () => {
    const now = 1_000_000
    writePendingCall(SESSION, call({ toolUseId: 'new', at: now - 1000 }), root)
    writePendingCall(SESSION, call({ toolUseId: 'old', at: now - 30_000 }), root)
    expect(readPendingCalls(SESSION, now, root)[0].toolUseId).toBe('old')
  })

  it('drops a call no PostToolUse ever closed', () => {
    const now = 1_000_000
    writePendingCall(SESSION, call({ at: now - PENDING_CALL_TTL_MS - 1 }), root)
    expect(readPendingCalls(SESSION, now, root)).toHaveLength(0)
  })

  it('forgets everything when the session ends', () => {
    writePendingCall(SESSION, call({ toolUseId: 'a' }), root)
    writePendingCall(SESSION, call({ toolUseId: 'b' }), root)
    clearSessionCalls(SESSION, root)
    expect(readPendingCalls(SESSION, Date.now(), root)).toHaveLength(0)
  })

  it('does not mistake the permission marker for a call', () => {
    markPermissionAsked(SESSION, root)
    expect(readPendingCalls(SESSION, Date.now(), root)).toHaveLength(0)
    expect(permissionWasAsked(SESSION, Date.now(), root)).toBe(true)
  })

  it('treats an old permission marker as spent', () => {
    // Stamped with the real clock, so the horizon has to be measured from it.
    markPermissionAsked(SESSION, root)
    expect(permissionWasAsked(SESSION, Date.now() + PENDING_CALL_TTL_MS + 1, root)).toBe(false)
  })

  it('says nothing was asked when nothing was', () => {
    expect(permissionWasAsked(SESSION, Date.now(), root)).toBe(false)
    expect(readPendingCalls('never-seen', Date.now(), root)).toEqual([])
  })
})

describe('when a call in flight becomes a card', () => {
  const now = 1_000_000

  it('shows nothing while no call is open', () => {
    expect(hookCardFor([], now, false)).toBeNull()
  })

  it('waits out the grace period before guessing', () => {
    // Otherwise every tool call in the session puts a card on screen, which is
    // unusable within seconds of real work.
    expect(hookCardFor([call({ at: now - 500 })], now, false)).toBeNull()
  })

  it('shows a call that has been open too long to be ordinary', () => {
    const card = hookCardFor([call({ at: now - CARD_GRACE_MS - 1 })], now, false)
    expect(card?.certain).toBe(false)
  })

  it('shows at once, and says so plainly, when the host confirmed a permission', () => {
    // `certain` is what lets the card say "needs your permission" instead of
    // "may need you". Only Notification can establish it, and the VS Code
    // extension never sends one.
    const card = hookCardFor([call({ at: now })], now, true)
    expect(card?.certain).toBe(true)
  })

  it('describes the call that has waited longest', () => {
    const calls = [call({ toolUseId: 'old', at: now - 60_000 }), call({ toolUseId: 'new', at: now })]
    expect(hookCardFor(calls, now, false)?.call.toolUseId).toBe('old')
  })
})

describe('telling a running command from a waiting one', () => {
  it('ignores the console host Windows attaches for the whole process life', () => {
    /*
     * Sampled once a second for 90 seconds against a live session: 88 samples
     * had only conhost.exe, and the two that also had bash.exe were exactly the
     * two tool calls made in that window. Counting conhost would report every
     * session as permanently busy and suppress every card.
     */
    expect(childrenMeanBusy(['conhost.exe'])).toBe(false)
    expect(childrenMeanBusy(['conhost.exe', 'bash.exe'])).toBe(true)
  })

  it('reads an empty child list as waiting', () => {
    // Permission is asked before the command runs, so no child plus an open
    // call means the question is still on the user's screen.
    expect(childrenMeanBusy([])).toBe(false)
    expect(childrenMeanBusy(['', '   '])).toBe(false)
  })

  it('does not care how the query cased or padded the name', () => {
    expect(childrenMeanBusy([' ConHost.EXE '])).toBe(false)
    expect(childrenMeanBusy([' PowerShell.exe '])).toBe(true)
  })
})

describe('not showing what a wrapper already shows', () => {
  function session(overrides: Partial<AgentSessionRecord>): AgentSessionRecord {
    return {
      id: 'wrapper-1',
      agentId: 'claude',
      pid: 100,
      hwnd: 1234,
      terminalKind: 'windows-terminal',
      terminalLabel: 'Windows Terminal',
      cwd: 'C:\\repo',
      startedAt: 0,
      heartbeatAt: 0,
      busy: false,
      ...overrides
    }
  }
  const hook = session({
    id: 'claude-hook-abc',
    hwnd: null,
    terminalKind: 'vscode',
    terminalLabel: 'Claude Code (no terminal)'
  })

  function map(...records: AgentSessionRecord[]): Map<string, AgentSessionRecord> {
    return new Map(records.map((record) => [record.id, record]))
  }

  it('defers to a wrapper watching the same directory', () => {
    // The wrapper's card can actually be answered; this one cannot.
    expect(wrapperOwnsCwd(map(hook, session({})), hook)).toBe(true)
  })

  it('ignores trailing separators and case', () => {
    expect(wrapperOwnsCwd(map(hook, session({ cwd: 'c:\\repo\\' })), hook)).toBe(true)
  })

  it('shows its own card when no wrapper is there', () => {
    expect(wrapperOwnsCwd(map(hook), hook)).toBe(false)
    expect(wrapperOwnsCwd(map(hook, session({ cwd: 'C:\\elsewhere' })), hook)).toBe(false)
  })

  it('is not fooled by another hook session in the same directory', () => {
    // Two extension chats open on one repo. Neither can answer for the other.
    const other = session({ id: 'claude-hook-def', hwnd: null })
    expect(wrapperOwnsCwd(map(hook, other), hook)).toBe(false)
  })

  it('is not fooled by another agent in the same directory', () => {
    expect(wrapperOwnsCwd(map(hook, session({ agentId: 'hermes' })), hook)).toBe(false)
  })
})
