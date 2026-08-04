import type { AgentId, AgentSnapshot, ApprovalRequest, IslandSnapshot } from '@shared/contracts'
import { AGENT_ORDER } from '@shared/contracts'
import { describeAdapterMode, getAdapter } from '@shared/adapters'
import type { PtySessionInfo } from '@shared/pty-types'
import { AgentTabs } from './AgentTabs'
import { ApprovalCard } from './ApprovalCard'
import { StatusDot } from './StatusDot'
import { MultiAgentTerminals } from './MultiAgentTerminals'

interface IslandShellProps {
  state: IslandSnapshot
  active: AgentSnapshot
  approval?: ApprovalRequest
  queueCount: number
  approveEnabled: boolean
  discoveryNote: string
  demoMode: boolean
  onSelectAgent: (agentId: AgentId) => void
  onClickPill: () => void
  onExpand: () => void
  onCollapse: () => void
  onApprove: () => void
  onDeny: () => void
  onDismiss: () => void
  onSessionChange?: (agentId: AgentId, info: PtySessionInfo | null, error?: string) => void
  onToggleDemo?: () => void
}

export function IslandShell(props: IslandShellProps) {
  const {
    state,
    active,
    approval,
    queueCount,
    approveEnabled,
    discoveryNote,
    demoMode,
    onSelectAgent,
    onClickPill,
    onExpand,
    onCollapse,
    onApprove,
    onDeny,
    onDismiss,
    onSessionChange,
    onToggleDemo
  } = props

  const adapter = getAdapter(active.id)
  const modeLabel = describeAdapterMode(active.integrationMode)

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

  const showTerminal = state.mode === 'expanded'
  // Keep terminal host mounted once user has expanded at least once in this open state cycle
  // so tab switches inside expanded don't remount. We unmount only when leaving expanded.
  // (PTY processes still survive collapse in main process.)

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
      ) : showTerminal ? (
        <MultiAgentTerminals
          agents={state.agents}
          activeAgentId={state.activeAgentId}
          discoveryNote={discoveryNote}
          visible
          onSessionChange={onSessionChange}
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
              <div className="muted tiny">
                {modeLabel}
                {!adapter.capabilities.islandApprovals && ' · approvals in terminal'}
              </div>
            </div>
          </div>
          <div className="muted tiny">{discoveryNote}</div>
          <div className="peek-actions">
            <button type="button" className="primary open-terminal" onClick={onExpand}>
              Open terminal
            </button>
            {onToggleDemo && (
              <button type="button" className="ghost" onClick={onToggleDemo}>
                {demoMode ? 'Hide demo' : 'Demo'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
