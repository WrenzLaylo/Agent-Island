import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decisionsDir as bridgeDecisionsDir,
  scanPending,
  writeDecision as writeBridgeDecision
} from '../../src/main/agents/approval-bridge'
import {
  isSafeFileId,
  parsePromptRecord,
  parseSessionRecord
} from '../../src/shared/session-registry'
import { pendingDir, readPendingCalls, writePendingCall } from '../../src/node/pending-calls'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-island-file-ipc-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('file IPC identifiers', () => {
  it('accepts stable ids and rejects traversal or path syntax', () => {
    for (const id of ['abc', 'claude-hook-a_b-123', 'toolu_01ABC']) expect(isSafeFileId(id)).toBe(true)
    for (const id of ['', '.', '..', '../outside', '..\\outside', 'a/b', 'a\\b', 'C:target', 'a.json']) {
      expect(isSafeFileId(id), id).toBe(false)
    }
  })

  it('rejects unsafe registry identities', () => {
    const session = {
      id: '../../outside',
      agentId: 'claude',
      pid: 1,
      hwnd: null,
      terminalKind: 'vscode',
      terminalLabel: 'VS Code',
      cwd: 'C:/repo',
      startedAt: 1,
      heartbeatAt: 1,
      busy: false
    }
    expect(parseSessionRecord(JSON.stringify(session))).toBeNull()
    expect(
      parsePromptRecord(
        JSON.stringify({
          sessionId: 'safe',
          promptId: '../outside',
          agentId: 'claude',
          kind: 'handoff'
        })
      )
    ).toBeNull()
  })

  it('requires bridge body id to match its filename and validates field types', async () => {
    const dir = join(root, 'pending')
    mkdirSync(dir, { recursive: true })
    const base = { command: 'git status', createdAt: Date.now() }
    writeFileSync(join(dir, 'request.json'), JSON.stringify({ ...base, id: '../../outside' }))
    writeFileSync(join(dir, 'wrong.json'), JSON.stringify({ ...base, id: 'different' }))
    writeFileSync(join(dir, 'bad-command.json'), JSON.stringify({ ...base, id: 'bad-command', command: ['git'] }))
    writeFileSync(join(dir, 'valid.json'), JSON.stringify({ ...base, id: 'valid' }))

    expect((await scanPending(root)).map((record) => record.id)).toEqual(['valid'])
  })

  it('never writes a bridge decision outside its decision directory', async () => {
    await expect(writeBridgeDecision('../../outside', 'once', root)).rejects.toThrow(/invalid/i)
    expect(() => readFileSync(join(root, 'outside.json'))).toThrow()
  })

  it('ignores unsafe pending-call ids instead of collapsing them onto one path', () => {
    writePendingCall('../session', {
      toolUseId: '../tool',
      toolName: 'Bash',
      command: 'git status',
      cwd: 'C:/repo',
      at: Date.now()
    }, root)
    expect(readPendingCalls('../session', Date.now(), root)).toEqual([])
    expect(() => readFileSync(join(root, 'calls', 'session', 'tool.json'))).toThrow()
  })

  it('keeps valid bridge decisions under the intended directory', async () => {
    await writeBridgeDecision('request-1', 'once', root)
    const value = JSON.parse(readFileSync(join(bridgeDecisionsDir(root), 'request-1.json'), 'utf8'))
    expect(value).toMatchObject({ id: 'request-1', choice: 'once' })
    expect(pendingDir('session-1', root)).toBe(join(root, 'calls', 'session-1'))
  })
})
