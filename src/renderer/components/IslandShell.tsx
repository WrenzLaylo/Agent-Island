import type { AgentId, AgentSnapshot, ApprovalRequest, IslandSnapshot } from '@shared/contracts'
import { AGENT_ORDER } from '@shared/contracts'
import type { PtySessionInfo } from '@shared/pty-types'
import { AgentTabs } from './AgentTabs'
import { ApprovalCard } from './ApprovalCard'
import { StatusDot } from './StatusDot'
import { TerminalPanel } from './TerminalPanel'

interface IslandShellProps {
  state: IslandSnapshot
  active: AgentSnapshot
  approval?: ApprovalRequest
  queueCount: number
  approveEnabled: boolean
  discoveryNote: string
  onSelectAgent: (agentId: AgentId) => void
  onClickPill: () => void
  onExpand: () => void
  onCollapse: () => void
  onApprove: () => void
  onDeny: () => void
  onDismiss: () => void
  onSessionChange?: (agentId: AgentId, info: PtySessionInfo | null, error?: string) => void
}

export function IslandShell(props: IslandShellProps) {
  const {
    state,
    active,
    approval,
    queueCount,
    approveEnabled,
    discoveryNote,
    onSelectAgent,
    onClickPill,
    onExpand,
    onCollapse,
    onApprove,
    onDeny,
    onDismiss,
    onSessionChange
  } = props

  if (state.mode === 'collapsed') {
    return (
      <button type="button" className="pill collapsed" onClick={onClickPill} aria-label="Open Agent Island">
        <StatusDot status={active.status} />
        <span className="pill-agent">{active.label.toUpperCase()}</span>
        <span className="pill-activity">{active.activityLabel}</span>
        {queueCount > 0 && <span className="badge">{queueCount}</span>}
      </button>
    )
  }

  return (
    <div className={`pill open mode-${state.mode}`} role="dialog" aria-label="Agent Island">
      <div className="pill-header">
        <AgentTabs
          agents={AGENT_ORDER.map((id) => state.agents[id])}
          activeAgentId={state.activeAgentId}
          onSelect={onSelectAgent}
        />
        <div className="header-actions">
          {queueCount > 1 && <span className="badge">{queueCount} waiting</span>}
          {state.mode !== 'expanded' && (
            <button type="button" className="ghost" onClick={onExpand}>
              Expand
            </button>
          )}
          <button type="button" className="ghost" onClick={onCollapse}>
            −
          </button>
        </div>
      </div>

      {state.mode === 'approval' && approval ? (
        <ApprovalCard
          approval={approval}
          approveEnabled={approveEnabled}
          onApprove={onApprove}
          onDeny={onDeny}
        />
      ) : state.mode === 'expanded' ? (
        <TerminalPanel
          agentId={active.id}
          label={active.label}
          cwd={active.cwd}
          available={active.available}
          discoveryNote={discoveryNote}
          onSessionChange={(info, error) => onSessionChange?.(active.id, info, error)}
        />
      ) : state.mode === 'error' ? (
        <div className="status-panel error">
          <strong>Error</strong>
          <p>{state.message ?? active.lastError ?? 'Something went wrong'}</p>
          <button type="button" className="ghost" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      ) : state.mode === 'success' ? (
        <div className="status-panel success">
          <strong>Done</strong>
          <p>{state.message ?? 'Completed'}</p>
        </div>
      ) : (
        <div className="status-panel">
          <div className="status-row">
            <StatusDot status={active.status} />
            <div>
              <div className="status-title">
                {active.label} · {active.status}
              </div>
              <div className="muted">{active.activityLabel}</div>
            </div>
          </div>
          <div className="muted tiny">{discoveryNote}</div>
          <button type="button" className="primary open-terminal" onClick={onExpand}>
            Open terminal
          </button>
        </div>
      )}
    </div>
  )
}
