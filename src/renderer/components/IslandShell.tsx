import type { AgentId, AgentSnapshot, ApprovalRequest, IslandSnapshot } from '@shared/contracts'
import { AGENT_ORDER } from '@shared/contracts'
import { AgentTabs } from './AgentTabs'
import { ApprovalCard } from './ApprovalCard'
import { StatusDot } from './StatusDot'

interface IslandShellProps {
  state: IslandSnapshot
  active: AgentSnapshot
  approval?: ApprovalRequest
  queueCount: number
  approveEnabled: boolean
  statusNote: string
  onSelectAgent: (agentId: AgentId) => void
  onClickPill: () => void
  onCollapse: () => void
  onApprove: () => void
  onDeny: () => void
  onDismiss: () => void
}

/**
 * Approval-only Dynamic Island.
 * Does not host AI terminals — only surfaces confirmations from live agents.
 */
export function IslandShell(props: IslandShellProps) {
  const {
    state,
    active,
    approval,
    queueCount,
    approveEnabled,
    statusNote,
    onSelectAgent,
    onClickPill,
    onCollapse,
    onApprove,
    onDeny,
    onDismiss
  } = props

  if (state.mode === 'collapsed') {
    return (
      <div className="pill collapsed">
        <div className="drag-handle" title="Drag" aria-label="Drag island" />
        <button type="button" className="pill-main" onClick={onClickPill} aria-label="Open Agent Island">
          <StatusDot status={queueCount > 0 ? 'waiting' : active.status} />
          <span className="pill-agent">
            {queueCount > 0 ? 'APPROVAL' : active.label.toUpperCase()}
          </span>
          <span className="pill-activity">
            {queueCount > 0
              ? `${queueCount} waiting`
              : active.activityLabel || 'Listening…'}
          </span>
          {queueCount > 0 && <span className="badge pulse">{queueCount}</span>}
        </button>
      </div>
    )
  }

  return (
    <div className={`pill open mode-${state.mode}`} role="dialog" aria-label="Agent Island">
      <div className="pill-header">
        <div className="drag-handle header-drag" title="Drag" aria-label="Drag island" />
        <AgentTabs
          agents={AGENT_ORDER.map((id) => state.agents[id])}
          activeAgentId={state.activeAgentId}
          onSelect={onSelectAgent}
        />
        <div className="header-actions">
          {queueCount > 0 && <span className="badge pulse">{queueCount}</span>}
          <button type="button" className="ghost" onClick={onCollapse} aria-label="Collapse">
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
      ) : state.mode === 'error' ? (
        <div className="status-panel error">
          <strong>Error</strong>
          <p>{state.message ?? 'Something went wrong'}</p>
          <button type="button" className="ghost" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      ) : (
        <div className="status-panel">
          <div className="status-row">
            <StatusDot status={queueCount > 0 ? 'waiting' : 'idle'} />
            <div>
              <div className="status-title">
                {queueCount > 0 ? 'Confirmation needed' : 'No pending confirmations'}
              </div>
              <div className="muted">
                {queueCount > 0
                  ? 'An agent is waiting for your decision'
                  : 'Connected to live Hermes sessions'}
              </div>
              <div className="muted tiny">{statusNote}</div>
            </div>
          </div>
          <p className="muted tiny hud-hint">
            This island does not run its own AI. It only shows approvals from your
            current Hermes terminals.
          </p>
        </div>
      )}
    </div>
  )
}
