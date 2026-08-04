import { describe, expect, it } from 'vitest'
import { canApproveRequest } from '../../src/shared/approval-guard'
import type { ApprovalRequest } from '../../src/shared/contracts'

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const now = 1_700_000_000_000
  return {
    id: 'req-1',
    agentId: 'hermes',
    summary: 'Run npm test',
    detail: 'npm test',
    cwd: 'C:/Users/OASIS/Downloads/agent-island',
    risk: 'low',
    createdAt: now,
    expiresAt: now + 60_000,
    processAlive: true,
    waitingForInput: true,
    answered: false,
    superseded: false,
    ...overrides
  }
}

describe('canApproveRequest', () => {
  it('allows a fresh verified request', () => {
    const request = makeRequest()
    expect(
      canApproveRequest({ request, displayedRequestId: 'req-1', now: request.createdAt + 1000 })
    ).toEqual({ canApprove: true })
  })

  it('rejects missing request', () => {
    expect(canApproveRequest({ request: undefined, displayedRequestId: 'req-1' })).toEqual({
      canApprove: false,
      reason: 'No matching request'
    })
  })

  it('rejects mismatched displayed id', () => {
    const request = makeRequest()
    expect(canApproveRequest({ request, displayedRequestId: 'other' }).canApprove).toBe(false)
  })

  it('rejects answered, superseded, expired, dead, or not-waiting requests', () => {
    const base = makeRequest()
    expect(canApproveRequest({ request: { ...base, answered: true }, displayedRequestId: 'req-1' }).canApprove).toBe(false)
    expect(canApproveRequest({ request: { ...base, superseded: true }, displayedRequestId: 'req-1' }).canApprove).toBe(false)
    expect(
      canApproveRequest({
        request: base,
        displayedRequestId: 'req-1',
        now: base.expiresAt + 1
      }).canApprove
    ).toBe(false)
    expect(
      canApproveRequest({
        request: { ...base, processAlive: false },
        displayedRequestId: 'req-1'
      }).canApprove
    ).toBe(false)
    expect(
      canApproveRequest({
        request: { ...base, waitingForInput: false },
        displayedRequestId: 'req-1'
      }).canApprove
    ).toBe(false)
  })

  it('rejects unknown risk', () => {
    const request = makeRequest({ risk: 'unknown' })
    expect(canApproveRequest({ request, displayedRequestId: 'req-1' }).canApprove).toBe(false)
  })
})
