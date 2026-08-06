import type { AgentId } from '@shared/contracts'
import type { SessionRow } from '@shared/session-list'
import { AgentMark } from './AgentMark'
import { StatusDot } from './StatusDot'

interface SessionListProps {
  rows: SessionRow[]
  onOpenSession: (agentId: AgentId, sessionId: string) => void
}

/**
 * One row per live `island` session, shown in place of the agent tabs once
 * more than one session exists.
 *
 * The tabs answer "which agent", which stops being the useful question the
 * moment two Claude sessions are running in different folders. These rows
 * answer "which session", and clicking one raises that exact terminal rather
 * than whichever session happened to register most recently.
 */
export function SessionList({ rows, onOpenSession }: SessionListProps) {
  if (rows.length === 0) return null

  return (
    <div className="session-list" role="list" aria-label="Live sessions" data-no-drag="true">
      {rows.map((row) => {
        // The terminal is always worth showing; the pid is added only when two
        // rows would otherwise read identically.
        const secondary = row.qualifier ? `${row.terminalLabel} · ${row.qualifier}` : row.terminalLabel
        return (
          <button
            key={row.id}
            type="button"
            role="listitem"
            data-no-drag="true"
            className={`session-row ${row.pendingApprovals > 0 ? 'is-waiting' : ''}`}
            // The visible row is short by design, so the full identity of the
            // session lives in the accessible name and the tooltip.
            title={
              row.raisable
                ? `${row.agentLabel} in ${row.folder || 'unknown folder'} · ${row.terminalLabel}`
                : `${row.terminalLabel} exposes no window that can be raised — switch to it manually`
            }
            aria-label={`Show ${row.agentLabel} session in ${row.folder || 'unknown folder'}, ${row.terminalLabel}`}
            disabled={!row.raisable}
            onClick={() => onOpenSession(row.agentId, row.id)}
          >
            <AgentMark agentId={row.agentId} mini />
            <span className="session-row-copy">
              <strong>{row.folder || row.agentLabel}</strong>
              <small>{secondary}</small>
            </span>
            {row.pendingApprovals > 0 ? (
              <span className="session-row-badge">{row.pendingApprovals}</span>
            ) : (
              <StatusDot status={row.busy ? 'running' : 'idle'} />
            )}
          </button>
        )
      })}
    </div>
  )
}
