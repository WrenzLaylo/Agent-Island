import { describe, expect, it } from 'vitest'
import {
  createInitialIslandState,
  currentApproval,
  pendingApprovalCount,
  reduceIsland
} from '../../src/shared/island-machine'
import type { ApprovalRequest } from '../../src/shared/contracts'

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const now = Date.now()
  return {
    id: 'a1',
    agentId: 'codex',
    summary: 'Install package',
    detail: 'npm install lodash',
    cwd: 'C:/project',
    risk: 'elevated',
    riskReason: 'Installs dependencies',
    createdAt: now,
    expiresAt: now + 120_000,
    processAlive: true,
    waitingForInput: true,
    answered: false,
    superseded: false,
    ...overrides
  }
}

describe('island state machine', () => {
  it('starts collapsed on Hermes', () => {
    const state = createInitialIslandState('C:/tmp')
    expect(state.mode).toBe('collapsed')
    expect(state.activeAgentId).toBe('hermes')
  })

  it('does not open on instant hover; opens on HOVER_OPEN and collapses on leave', () => {
    let state = createInitialIslandState()
    state = reduceIsland(state, { type: 'HOVER_ENTER' })
    expect(state.mode).toBe('collapsed')
    expect(state.hovered).toBe(true)
    state = reduceIsland(state, { type: 'HOVER_OPEN' })
    expect(state.mode).toBe('peek')
    state = reduceIsland(state, { type: 'HOVER_LEAVE' })
    expect(state.mode).toBe('collapsed')
  })

  it('opens peek immediately on click', () => {
    let state = createInitialIslandState()
    state = reduceIsland(state, { type: 'CLICK_PILL' })
    expect(state.mode).toBe('peek')
  })

  it('expands to approval and switches agent when a request arrives', () => {
    let state = createInitialIslandState()
    state = reduceIsland(state, { type: 'ENQUEUE_APPROVAL', request: approval() })
    expect(state.mode).toBe('approval')
    expect(state.activeAgentId).toBe('codex')
    expect(pendingApprovalCount(state)).toBe(1)
    expect(currentApproval(state)?.detail).toBe('npm install lodash')
  })

  it('approves once and enters success when queue empties', () => {
    let state = createInitialIslandState()
    state = reduceIsland(state, { type: 'ENQUEUE_APPROVAL', request: approval() })
    state = reduceIsland(state, { type: 'ANSWER_APPROVAL', requestId: 'a1', decision: 'approve' })
    expect(state.mode).toBe('success')
    expect(state.approvals.a1.answered).toBe(true)
    expect(pendingApprovalCount(state)).toBe(0)
  })

  it('keeps approval mode when more requests remain', () => {
    let state = createInitialIslandState()
    state = reduceIsland(state, { type: 'ENQUEUE_APPROVAL', request: approval({ id: 'a1' }) })
    state = reduceIsland(state, {
      type: 'ENQUEUE_APPROVAL',
      request: approval({ id: 'a2', agentId: 'hermes', summary: 'Edit file', detail: 'patch App.tsx' })
    })
    state = reduceIsland(state, { type: 'ANSWER_APPROVAL', requestId: 'a1', decision: 'deny' })
    expect(state.mode).toBe('approval')
    expect(currentApproval(state)?.id).toBe('a2')
  })

  it('refuses stale approve attempts', () => {
    let state = createInitialIslandState()
    state = reduceIsland(state, {
      type: 'ENQUEUE_APPROVAL',
      request: approval({ id: 'stale', processAlive: false })
    })
    state = reduceIsland(state, { type: 'ANSWER_APPROVAL', requestId: 'stale', decision: 'approve' })
    expect(state.mode).toBe('error')
    expect(state.approvals.stale.answered).toBe(false)
  })

  it('does not auto-collapse success while hovered', () => {
    let state = createInitialIslandState()
    state = reduceIsland(state, { type: 'HOVER_ENTER' })
    state = reduceIsland(state, { type: 'COMPLETE', message: 'Tests passed' })
    expect(state.mode).toBe('peek')
    expect(state.message).toBe('Tests passed')
  })

  it('selects agent tabs', () => {
    let state = createInitialIslandState()
    state = reduceIsland(state, { type: 'SELECT_AGENT', agentId: 'claude' })
    expect(state.activeAgentId).toBe('claude')
    expect(state.mode).toBe('peek')
  })
})
