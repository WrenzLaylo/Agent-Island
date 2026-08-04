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
  discoveryNote: string
  onSelectAgent: (agentId: AgentId) => void
  onClickPill: () => void
  onExpand: () => void
  onCollapse: () => void
  onApprove: () => void
  onDeny: () => void
  onDismiss: () => void
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
    onDismiss
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
        <div className="terminal-panel">
          <div className="terminal-meta">
            <span>{active.label}</span>
            <span className="muted">{active.cwd}</span>
          </div>
          <div className="terminal-body" aria-label="Simulated terminal">
            <div className="term-line muted"># Phase 1 visual shell — PTY arrives in Phase 2</div>
            <div className="term-line">$ agent-island --session {active.id}</div>
            <div className="term-line">{active.activityLabel}</div>
            <div className="term-line muted">{discoveryNote}</div>
            <div className="term-line caret">▌</div>
          </div>
          <div className="terminal-input-row">
            <input className="terminal-input" placeholder="Type a message… (wired in Phase 2)" disabled />
            <button type="button" className="primary" disabled>
              Send
            </button>
          </div>
        </div>
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
        </div>
      )}
    </div>
  )
}
