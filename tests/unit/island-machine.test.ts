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
    state = reduceIsland(state, { type: 'ANSWER_APPROVAL', requestId: 'a1', decision: 'once' })
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
    state = reduceIsland(state, { type: 'ANSWER_APPROVAL', requestId: 'stale', decision: 'once' })
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

  it('returns a resolved approval confirmation to the compact pill', () => {
    let state = createInitialIslandState()
    state = reduceIsland(state, { type: 'ENQUEUE_APPROVAL', request: approval() })
    state = reduceIsland(state, { type: 'ANSWER_APPROVAL', requestId: 'a1', decision: 'session' })
    expect(state.mode).toBe('success')
    expect(state.focused).toBe(false)
    state = reduceIsland(state, { type: 'DISMISS_TRANSIENT' })
    expect(state.mode).toBe('collapsed')
    expect(state.hovered).toBe(false)
  })


  it('can keep a new approval compact when auto-expand is disabled', () => {
    let state = createInitialIslandState()
    state = reduceIsland(state, {
      type: 'ENQUEUE_APPROVAL',
      request: approval({ agentId: 'hermes' }),
      autoExpand: false
    })
    expect(state.mode).toBe('collapsed')
    expect(pendingApprovalCount(state)).toBe(1)

    state = reduceIsland(state, { type: 'CLICK_PILL' })
    expect(state.mode).toBe('approval')
  })

  it('allows a pending approval panel to be manually collapsed', () => {
    let state = createInitialIslandState()
    state = reduceIsland(state, { type: 'ENQUEUE_APPROVAL', request: approval() })
    state = reduceIsland(state, { type: 'COLLAPSE' })
    expect(state.mode).toBe('collapsed')
    expect(pendingApprovalCount(state)).toBe(1)
  })

  it('rejects permission choices that the live request did not expose', () => {
    let state = createInitialIslandState()
    state = reduceIsland(state, {
      type: 'ENQUEUE_APPROVAL',
      request: approval({ choices: ['once', 'deny'] })
    })
    state = reduceIsland(state, {
      type: 'ANSWER_APPROVAL',
      requestId: 'a1',
      decision: 'always'
    })
    expect(state.mode).toBe('error')
    expect(state.approvals.a1.answered).toBe(false)
  })

  it('removes an expired request and returns to the pill after dismissal', () => {
    let state = createInitialIslandState()
    state = reduceIsland(state, {
      type: 'ENQUEUE_APPROVAL',
      request: approval({ id: 'expired', expiresAt: Date.now() - 1 })
    })
    state = reduceIsland(state, {
      type: 'INVALIDATE_APPROVAL',
      requestId: 'expired',
      kind: 'expired'
    })
    expect(state.mode).toBe('error')
    expect(pendingApprovalCount(state)).toBe(0)
    expect(state.transientKind).toBe('expired')

    state = reduceIsland(state, { type: 'DISMISS_TRANSIENT' })
    expect(state.mode).toBe('collapsed')
  })

  it('selects agent tabs', () => {
    let state = createInitialIslandState()
    state = reduceIsland(state, { type: 'SELECT_AGENT', agentId: 'claude' })
    expect(state.activeAgentId).toBe('claude')
    expect(state.mode).toBe('peek')
  })

  it('queues by when the agent asked, not when the island noticed', () => {
    // Prompts arrive from a directory listing and in a startup batch, so
    // arrival order is filesystem order. Showing whichever was read first
    // and calling it the oldest was simply untrue.
    const later = approval({ id: 'later', createdAt: 2000, sessionId: 's2' })
    const earlier = approval({ id: 'earlier', createdAt: 1000, sessionId: 's1' })

    let state = createInitialIslandState()
    state = reduceIsland(state, { type: 'ENQUEUE_APPROVAL', request: later })
    state = reduceIsland(state, { type: 'ENQUEUE_APPROVAL', request: earlier })

    expect(state.approvalQueue).toEqual(['earlier', 'later'])
    expect(currentApproval(state)?.id).toBe('earlier')
    expect(pendingApprovalCount(state)).toBe(2)
  })

  it('keeps the shown request and the active agent in step', () => {
    // The newly arrived request used to become the active agent even while
    // an older one was still the one on screen.
    const shown = approval({ id: 'shown', createdAt: 1000, agentId: 'claude' })
    const queued = approval({ id: 'queued', createdAt: 2000, agentId: 'codex' })

    let state = createInitialIslandState()
    state = reduceIsland(state, { type: 'ENQUEUE_APPROVAL', request: shown })
    state = reduceIsland(state, { type: 'ENQUEUE_APPROVAL', request: queued })

    expect(currentApproval(state)?.id).toBe('shown')
    expect(state.activeAgentId).toBe('claude')
  })
})

describe('SHOW_APPROVAL', () => {
  function withTwoQueued() {
    let state = createInitialIslandState('/w', 'claude')
    const base = {
      agentId: 'claude' as const,
      summary: 's',
      detail: 'd',
      cwd: '/w',
      risk: 'low' as const,
      processAlive: true,
      waitingForInput: true,
      answered: false,
      superseded: false
    }
    state = reduceIsland(state, {
      type: 'ENQUEUE_APPROVAL',
      request: { ...base, id: 'old', sessionId: 'a', createdAt: 1, expiresAt: 9_000_000_000_000 }
    })
    state = reduceIsland(state, {
      type: 'ENQUEUE_APPROVAL',
      request: { ...base, id: 'new', sessionId: 'b', createdAt: 2, expiresAt: 9_000_000_000_000 }
    })
    return state
  }

  it('queues oldest-first by default', () => {
    expect(withTwoQueued().approvalQueue).toEqual(['old', 'new'])
  })

  it('brings the requested approval to the front', () => {
    // Picking a session says "that one", which outranks arrival order.
    const state = reduceIsland(withTwoQueued(), { type: 'SHOW_APPROVAL', requestId: 'new' })
    expect(state.approvalQueue).toEqual(['new', 'old'])
    expect(state.mode).toBe('approval')
  })

  it('keeps the rest of the queue in order', () => {
    const state = reduceIsland(withTwoQueued(), { type: 'SHOW_APPROVAL', requestId: 'new' })
    expect(state.approvalQueue.slice(1)).toEqual(['old'])
  })

  it('ignores an id that is not queued', () => {
    const before = withTwoQueued()
    expect(reduceIsland(before, { type: 'SHOW_APPROVAL', requestId: 'nope' })).toBe(before)
  })
})

describe('answered in the terminal', () => {
  function queued() {
    let state = createInitialIslandState('/w', 'claude')
    state = reduceIsland(state, {
      type: 'ENQUEUE_APPROVAL',
      request: {
        id: 'req-1',
        agentId: 'claude',
        summary: 's',
        detail: 'd',
        cwd: '/w',
        risk: 'low',
        createdAt: 1,
        expiresAt: 9_000_000_000_000,
        processAlive: true,
        waitingForInput: true,
        answered: false,
        superseded: false
      }
    })
    return state
  }

  it('reports the user answering it, not the request closing', () => {
    const state = reduceIsland(queued(), {
      type: 'INVALIDATE_APPROVAL',
      requestId: 'req-1',
      message: 'You answered this in the terminal.',
      kind: 'answered-elsewhere'
    })
    expect(state.transientKind).toBe('answered-elsewhere')
    expect(state.message).toBe('You answered this in the terminal.')
  })

  it('still reports a genuine close as cancelled', () => {
    const state = reduceIsland(queued(), {
      type: 'INVALIDATE_APPROVAL',
      requestId: 'req-1',
      message: 'The agent moved on before this was answered.',
      kind: 'cancelled'
    })
    expect(state.transientKind).toBe('cancelled')
  })

  it('drops the request from the queue either way', () => {
    const state = reduceIsland(queued(), {
      type: 'INVALIDATE_APPROVAL',
      requestId: 'req-1',
      kind: 'answered-elsewhere'
    })
    expect(state.approvalQueue).not.toContain('req-1')
  })
})
