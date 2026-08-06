import { AGENT_LABELS, type AgentId, type ApprovalRequest } from './contracts'
import type { AgentSessionRecord } from './session-registry'

/**
 * Last path segment of a working directory.
 *
 * Two sessions of the same agent in the same kind of terminal read identically
 * — "Claude in Windows Terminal" twice over. The folder is what actually
 * differs between concurrent sessions, and acting on the wrong one is not
 * recoverable.
 *
 * Deliberately not a regex: an earlier version used a `[\/]` character class
 * that collapsed to forward-slash only, so Windows paths never split and the
 * UI printed the full path where a folder name belonged.
 */
export function folderName(cwd: string | undefined): string {
  if (!cwd) return ''
  const separators = ['/', String.fromCharCode(92)]
  let end = cwd.length
  while (end > 0 && separators.includes(cwd[end - 1])) end -= 1
  const trimmed = cwd.slice(0, end)
  let cut = -1
  for (const separator of separators) cut = Math.max(cut, trimmed.lastIndexOf(separator))
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed
}

export interface SessionRow {
  id: string
  agentId: AgentId
  agentLabel: string
  /** Primary discriminator between concurrent sessions. */
  folder: string
  terminalLabel: string
  /**
   * Last-resort discriminator, appended to the terminal label only when agent,
   * folder *and* terminal all collide. Empty for every other case, so the list
   * stays quiet until ambiguity earns the noise.
   */
  qualifier: string
  busy: boolean
  pendingApprovals: number
  /**
   * False when the wrapper never resolved a host window (VS Code panels, and
   * any emulator the handshake does not recognise). Such a row cannot be
   * raised, and must say so rather than failing silently on click.
   */
  raisable: boolean
}

/**
 * Flatten live sessions into rows the island can list and act on.
 *
 * Ordering is by start time, oldest first, and deliberately does NOT float
 * busy or approval-pending sessions to the top. Rows that reorder underneath a
 * cursor are the same class of hazard as the approval re-arm window: the user
 * aims at one row and the list moves a different one under the click. A
 * session's position stays put for as long as it lives.
 */
export function buildSessionRows(
  sessions: AgentSessionRecord[],
  approvals: ApprovalRequest[] = []
): SessionRow[] {
  const pendingBySession = new Map<string, number>()
  for (const approval of approvals) {
    if (approval.answered || approval.superseded) continue
    if (!approval.sessionId) continue
    pendingBySession.set(approval.sessionId, (pendingBySession.get(approval.sessionId) ?? 0) + 1)
  }

  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))

  // The row already shows agent, folder and terminal. A qualifier is only
  // earned when all three collide and the row would otherwise be a duplicate.
  const terminalCount = new Map<string, number>()
  for (const session of ordered) {
    const key = `${session.agentId}|${folderName(session.cwd)}|${session.terminalLabel}`
    terminalCount.set(key, (terminalCount.get(key) ?? 0) + 1)
  }

  return ordered.map((session) => {
    const folder = folderName(session.cwd)
    const terminalKey = `${session.agentId}|${folder}|${session.terminalLabel}`
    // The pid is the last thing guaranteed to be unique between two sessions
    // that are otherwise identical.
    const qualifier = (terminalCount.get(terminalKey) ?? 0) > 1 ? `pid ${session.pid}` : ''

    return {
      id: session.id,
      agentId: session.agentId,
      agentLabel: AGENT_LABELS[session.agentId],
      folder,
      terminalLabel: session.terminalLabel,
      qualifier,
      busy: session.busy,
      pendingApprovals: pendingBySession.get(session.id) ?? 0,
      raisable: session.hwnd != null
    }
  })
}
