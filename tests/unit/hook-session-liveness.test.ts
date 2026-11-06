import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentPid, touchSession } from '../../src/hooks/mirror-store'
import { sessionShouldBeReaped, UNKNOWN_LIVENESS_TTL_MS } from '../../src/main/agents/session-watcher'
import { SESSION_STALE_MS, type AgentSessionRecord } from '../../src/shared/session-registry'

/**
 * The bug these cover, in one line: a hook-hosted session recorded the pid of
 * the shell that ran the hook, and that shell is dead before the hook's output
 * is even read.
 *
 * Measured on the development machine — record written 20:16:48 naming pid
 * 29912, and 29912 already gone at 20:16:52 — so every such session was reaped
 * `SESSION_STALE_MS` after its last tool call, prompt file included. The window
 * it disappeared in is the window a user spends reading the dialog.
 */

let root: string
const CLAUDE_PID = process.env.CLAUDE_PID
const LOCALAPPDATA = process.env.LOCALAPPDATA

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-island-test-'))
  process.env.LOCALAPPDATA = root
})

afterEach(() => {
  if (CLAUDE_PID === undefined) delete process.env.CLAUDE_PID
  else process.env.CLAUDE_PID = CLAUDE_PID
  if (LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = LOCALAPPDATA
  rmSync(root, { recursive: true, force: true })
})

function readRecord(sessionId: string): AgentSessionRecord {
  const path = join(root, 'agent-island', 'sessions', `claude-hook-${sessionId}.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as AgentSessionRecord
}

describe('agentPid', () => {
  it('reads the agent pid Claude Code exports', () => {
    process.env.CLAUDE_PID = '4668'
    expect(agentPid()).toBe(4668)
  })

  it('reports 0 rather than guessing when the variable is absent', () => {
    delete process.env.CLAUDE_PID
    expect(agentPid()).toBe(0)
  })

  it('rejects values that are not a usable pid', () => {
    for (const value of ['', 'claude', '0', '-1', 'NaN']) {
      process.env.CLAUDE_PID = value
      expect(agentPid()).toBe(0)
    }
  })

  it('is never the hook process parent', () => {
    // The whole defect: `process.ppid` here is a `cmd.exe` that exits the moment
    // the hook returns, four hops below the agent in the real chain
    // (node -> cmd.exe -> bash -> bash -> claude.exe).
    process.env.CLAUDE_PID = String(process.ppid + 1)
    expect(agentPid()).not.toBe(process.ppid)
  })
})

describe('touchSession', () => {
  it('records the agent pid, not the shell that ran the hook', () => {
    process.env.CLAUDE_PID = '4668'
    touchSession('abc', 'C:\\repo')
    expect(readRecord('abc').pid).toBe(4668)
  })

  it('keeps a pid it already resolved when the variable goes missing', () => {
    // An older Claude Code exports nothing. A pid learned once is still better
    // than none, so a later hook must not downgrade it to 0.
    process.env.CLAUDE_PID = '4668'
    touchSession('abc', 'C:\\repo')
    delete process.env.CLAUDE_PID
    touchSession('abc', 'C:\\repo')
    expect(readRecord('abc').pid).toBe(4668)
  })

  it('keeps the original start time while refreshing the heartbeat', () => {
    process.env.CLAUDE_PID = '4668'
    touchSession('abc', 'C:\\repo')
    const first = readRecord('abc')
    touchSession('abc', 'C:\\repo')
    const second = readRecord('abc')
    expect(second.startedAt).toBe(first.startedAt)
    expect(second.heartbeatAt).toBeGreaterThanOrEqual(first.heartbeatAt)
  })

  it('marks the session as having no window to raise', () => {
    process.env.CLAUDE_PID = '4668'
    touchSession('abc', 'C:\\repo')
    // A webview panel cannot be focused from outside, so offering a handoff
    // button would be offering something that cannot work.
    expect(readRecord('abc').hwnd).toBeNull()
  })
})

describe('sessionShouldBeReaped', () => {
  const base: AgentSessionRecord = {
    id: 'claude-hook-abc',
    agentId: 'claude',
    pid: 4668,
    hwnd: null,
    terminalKind: 'vscode',
    terminalLabel: 'Claude Code (no terminal)',
    cwd: 'C:\\repo',
    startedAt: 0,
    heartbeatAt: 0,
    busy: false
  }
  const now = 10_000_000
  const stale = { ...base, heartbeatAt: now - SESSION_STALE_MS - 1 }
  const fresh = { ...base, heartbeatAt: now }
  const alive = () => true
  const dead = () => false

  it('keeps a session that checked in recently, whatever its pid', () => {
    expect(sessionShouldBeReaped(fresh, now, 0, dead)).toBe(false)
  })

  it('reaps a stale session whose pid is gone', () => {
    // The case this test exists to preserve: a wrapper killed rather than
    // exited still has to be cleaned up.
    expect(sessionShouldBeReaped(stale, now, 0, dead)).toBe(true)
  })

  it('keeps a stale session whose pid is alive', () => {
    // Nothing heartbeats a hook-hosted session, so every one of them is stale
    // between tool calls. The pid is what says it is still there.
    expect(sessionShouldBeReaped(stale, now, 0, alive)).toBe(false)
  })

  it('does not reap a session it cannot identify', () => {
    // The regression. pid 0 fails a liveness test exactly like a dead process,
    // and folding the two together deleted live sessions on a 20-second timer.
    const unknown = { ...stale, pid: 0 }
    expect(sessionShouldBeReaped(unknown, now, 60_000, dead)).toBe(false)
  })

  it('eventually reaps an unidentifiable session by age alone', () => {
    const unknown = { ...stale, pid: 0 }
    expect(sessionShouldBeReaped(unknown, now, UNKNOWN_LIVENESS_TTL_MS + 1, dead)).toBe(true)
  })

  it('treats a negative or absent pid the same as an unknown one', () => {
    for (const pid of [-1, Number.NaN]) {
      expect(sessionShouldBeReaped({ ...stale, pid }, now, 0, dead)).toBe(false)
    }
  })
})
