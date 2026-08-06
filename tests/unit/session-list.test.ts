import { describe, expect, it } from 'vitest'
import { buildSessionRows, folderName } from '../../src/shared/session-list'
import type { AgentSessionRecord } from '../../src/shared/session-registry'
import type { ApprovalRequest } from '../../src/shared/contracts'

const BACKSLASH = String.fromCharCode(92)

function makeSession(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  const now = 1_700_000_000_000
  return {
    id: 'sess-1',
    agentId: 'claude',
    pid: 4242,
    hwnd: 65_536,
    terminalKind: 'windows-terminal',
    terminalLabel: 'Windows Terminal',
    cwd: `C:${BACKSLASH}work${BACKSLASH}api-service`,
    // Small so that a test overriding startedAt on a *later* session sorts
    // after this default rather than billions of milliseconds before it.
    startedAt: 1_000,
    heartbeatAt: now,
    busy: false,
    ...overrides
  }
}

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const now = 1_700_000_000_000
  return {
    id: 'req-1',
    agentId: 'claude',
    summary: 'Run rm -rf ./dist',
    detail: 'rm -rf ./dist',
    cwd: `C:${BACKSLASH}work${BACKSLASH}api-service`,
    risk: 'high',
    createdAt: now,
    expiresAt: now + 60_000,
    processAlive: true,
    waitingForInput: true,
    answered: false,
    superseded: false,
    ...overrides
  }
}

describe('folderName', () => {
  it('takes the last segment of a Windows path', () => {
    expect(folderName(`C:${BACKSLASH}work${BACKSLASH}api-service`)).toBe('api-service')
  })

  it('takes the last segment of a POSIX path', () => {
    expect(folderName('/home/user/proj')).toBe('proj')
  })

  it('ignores trailing separators', () => {
    expect(folderName(`C:${BACKSLASH}work${BACKSLASH}web-frontend${BACKSLASH}`)).toBe('web-frontend')
  })

  it('returns a drive root as itself rather than an empty label', () => {
    expect(folderName(`C:${BACKSLASH}`)).toBe('C:')
  })

  it('passes through a bare folder name', () => {
    expect(folderName('proj')).toBe('proj')
  })

  it('handles a missing cwd', () => {
    expect(folderName(undefined)).toBe('')
    expect(folderName('')).toBe('')
  })
})

describe('buildSessionRows', () => {
  it('orders by start time, oldest first, so rows do not move under the cursor', () => {
    const rows = buildSessionRows([
      makeSession({ id: 'newer', startedAt: 2_000 }),
      makeSession({ id: 'older', startedAt: 1_000 }),
      makeSession({ id: 'newest', startedAt: 3_000 })
    ])
    expect(rows.map((row) => row.id)).toEqual(['older', 'newer', 'newest'])
  })

  it('does not float a busy or approval-pending session to the top', () => {
    const rows = buildSessionRows(
      [
        makeSession({ id: 'first', startedAt: 1_000 }),
        makeSession({ id: 'second', startedAt: 2_000, busy: true })
      ],
      [makeApproval({ sessionId: 'second' })]
    )
    expect(rows.map((row) => row.id)).toEqual(['first', 'second'])
  })

  it('breaks ties on id so ordering is deterministic', () => {
    const rows = buildSessionRows([
      makeSession({ id: 'b', startedAt: 1_000 }),
      makeSession({ id: 'a', startedAt: 1_000 })
    ])
    expect(rows.map((row) => row.id)).toEqual(['a', 'b'])
  })

  it('spends no qualifier when the folder already separates the sessions', () => {
    const rows = buildSessionRows([
      makeSession({ id: 'a', cwd: `C:${BACKSLASH}work${BACKSLASH}api-service` }),
      makeSession({ id: 'b', startedAt: 2_000, cwd: `C:${BACKSLASH}work${BACKSLASH}web-frontend` })
    ])
    expect(rows.map((row) => row.folder)).toEqual(['api-service', 'web-frontend'])
    expect(rows.every((row) => row.qualifier === '')).toBe(true)
  })

  it('does not qualify same-folder sessions belonging to different agents', () => {
    const rows = buildSessionRows([
      makeSession({ id: 'a', agentId: 'claude' }),
      makeSession({ id: 'b', agentId: 'codex', startedAt: 2_000 })
    ])
    expect(rows.map((row) => row.qualifier)).toEqual(['', ''])
    expect(rows.map((row) => row.agentLabel)).toEqual([
      rows[0].agentLabel,
      rows[1].agentLabel
    ])
    expect(rows[0].agentLabel).not.toBe(rows[1].agentLabel)
  })

  it('spends no qualifier when the terminal already separates same-folder sessions', () => {
    // The row shows the terminal label regardless, so adding a pid here would
    // be noise on top of a discriminator the user can already see.
    const rows = buildSessionRows([
      makeSession({ id: 'a', terminalLabel: 'Windows Terminal' }),
      makeSession({ id: 'b', startedAt: 2_000, terminalKind: 'mintty', terminalLabel: 'Git Bash' })
    ])
    expect(rows.map((row) => row.qualifier)).toEqual(['', ''])
    expect(rows.map((row) => row.terminalLabel)).toEqual(['Windows Terminal', 'Git Bash'])
  })

  it('falls back to the pid when agent, folder and terminal all collide', () => {
    const rows = buildSessionRows([
      makeSession({ id: 'a', pid: 111 }),
      makeSession({ id: 'b', startedAt: 2_000, pid: 222 })
    ])
    expect(rows.map((row) => row.qualifier)).toEqual(['pid 111', 'pid 222'])
  })

  it('counts only unanswered approvals, against the session that raised them', () => {
    const rows = buildSessionRows(
      [makeSession({ id: 'a' }), makeSession({ id: 'b', startedAt: 2_000 })],
      [
        makeApproval({ id: 'r1', sessionId: 'a' }),
        makeApproval({ id: 'r2', sessionId: 'a' }),
        makeApproval({ id: 'r3', sessionId: 'a', answered: true }),
        makeApproval({ id: 'r4', sessionId: 'a', superseded: true }),
        makeApproval({ id: 'r5', sessionId: 'unknown-session' }),
        makeApproval({ id: 'r6' })
      ]
    )
    expect(rows.find((row) => row.id === 'a')?.pendingApprovals).toBe(2)
    expect(rows.find((row) => row.id === 'b')?.pendingApprovals).toBe(0)
  })

  it('marks a session with no host window as not raisable', () => {
    const rows = buildSessionRows([makeSession({ hwnd: null, terminalLabel: 'VS Code terminal' })])
    expect(rows[0].raisable).toBe(false)
  })

  it('returns nothing for no sessions', () => {
    expect(buildSessionRows([])).toEqual([])
  })
})
