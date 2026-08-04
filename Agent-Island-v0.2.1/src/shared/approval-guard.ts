import type { ApprovalRequest } from './contracts'

export interface ApprovalGuardInput {
  request: ApprovalRequest | undefined
  displayedRequestId: string
  now?: number
}

export interface ApprovalGuardResult {
  canApprove: boolean
  reason?: string
}

/**
 * Safety gate for island Approve Once.
 * All invariants from the product plan must pass.
 */
export function canApproveRequest(input: ApprovalGuardInput): ApprovalGuardResult {
  const { request, displayedRequestId } = input
  const now = input.now ?? Date.now()

  if (!request) {
    return { canApprove: false, reason: 'No matching request' }
  }

  if (request.id !== displayedRequestId) {
    return { canApprove: false, reason: 'Displayed request does not match current request' }
  }

  if (request.answered) {
    return { canApprove: false, reason: 'Request already answered' }
  }

  if (request.superseded) {
    return { canApprove: false, reason: 'Request was superseded' }
  }

  if (now > request.expiresAt) {
    return { canApprove: false, reason: 'Request expired' }
  }

  if (!request.processAlive) {
    return { canApprove: false, reason: 'Source process is not alive' }
  }

  if (!request.waitingForInput) {
    return { canApprove: false, reason: 'Process is no longer waiting for input' }
  }

  if (request.risk === 'unknown') {
    return { canApprove: false, reason: 'Unknown risk — open terminal instead' }
  }

  return { canApprove: true }
}
