import type { ApprovalRequest } from './contracts'

/**
 * How long a freshly displayed approval keeps every button inert.
 *
 * Answering one approval promotes the next queued one straight into the same
 * card, with its buttons in the same screen position the cursor is already
 * resting in. Nothing else stops a second click landing there: the only other
 * gate is the resize lock, and consecutive cards with the same number of
 * choices resize to the same height, so that effect never re-runs and never
 * disarms anything.
 *
 * The window has to outlast a double-click (Windows default threshold is
 * 500ms, but the second click of an *accidental* double lands far sooner) yet
 * stay short enough that a deliberate answer never feels blocked. It applies
 * to deny as much as approve — answering "No" to a request you never read
 * still interrupts an agent that was waiting on you.
 */
export const APPROVAL_REARM_MS = 350

/**
 * Has the displayed approval been on screen long enough to accept a click?
 *
 * `shownAt` is when this particular request id took over the card, not when
 * the request was created — a request can sit in the queue for minutes and
 * still be brand new to the user's eyes.
 */
export function approvalReArmed(shownAt: number, now: number, delayMs = APPROVAL_REARM_MS): boolean {
  if (!Number.isFinite(shownAt) || !Number.isFinite(now)) return false
  if (delayMs <= 0) return true
  // A shownAt in the future would otherwise read as "elapsed", so clamp to the
  // inert side: staying disabled a moment too long is the recoverable failure.
  return now - shownAt >= delayMs
}

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
