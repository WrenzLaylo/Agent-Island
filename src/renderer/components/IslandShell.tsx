import { AnimatePresence, motion } from 'framer-motion'
import type {
  AgentId,
  AgentSnapshot,
  ApprovalRequest,
  DockSide,
  IslandSnapshot
} from '@shared/contracts'
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
  docked: DockSide | null
  attentionNonce: number
  onSelectAgent: (agentId: AgentId) => void
  onClickPill: () => void
  onCollapse: () => void
  onApprove: () => void
  onDeny: () => void
  onDismiss: () => void
}

interface IconProps {
  size?: number
  className?: string
}

function ChevronIcon({ size = 14, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m9.5 7 5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CloseIcon({ size = 15, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m8 8 8 8M16 8l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function CheckIcon({ size = 17, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5.5 12.5 4 4 9-10" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function AlertIcon({ size = 17, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 4.25 3.4 19h17.2L12 4.25Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M12 9.5v4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="1" fill="currentColor" />
    </svg>
  )
}

function HermesMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`hermes-mark ${compact ? 'mark-compact' : ''}`} aria-hidden="true">
      <span className="hermes-glyph">H</span>
      <span className="mark-sheen" />
    </span>
  )
}

function ActivityGlyph({ waiting = false }: { waiting?: boolean }) {
  return (
    <span className={`activity-glyph ${waiting ? 'is-waiting' : ''}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}

const spring = { type: 'spring' as const, stiffness: 420, damping: 28, mass: 0.9 }

export function IslandShell(props: IslandShellProps) {
  const {
    state,
    active,
    approval,
    queueCount,
    approveEnabled,
    statusNote,
    docked,
    attentionNonce,
    onSelectAgent,
    onClickPill,
    onCollapse,
    onApprove,
    onDeny,
    onDismiss
  } = props

  const dockClass = docked ? `anchored-${docked}` : ''
  const hasApproval = queueCount > 0

  if (state.mode === 'collapsed' && docked) {
    return (
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          layout
          key={`dock-${docked}`}
          className={`island-surface dock-orb ${hasApproval ? 'needs-attention' : ''} ${dockClass}`}
          data-drag-region="true"
          initial={{ opacity: 0, scale: 0.78 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={spring}
        >
          <button
            type="button"
            className="dock-button"
            data-drag-region="true"
            onClick={onClickPill}
            aria-label="Open Agent Island"
          >
            <HermesMark compact />
            <StatusDot status={hasApproval ? 'waiting' : active.status} />
            {hasApproval ? <span className="floating-badge">{queueCount}</span> : null}
          </button>
        </motion.div>
      </AnimatePresence>
    )
  }

  if (state.mode === 'collapsed') {
    return (
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          layout
          key="compact"
          className={`island-surface compact-island ${hasApproval ? 'needs-attention' : ''}`}
          data-drag-region="true"
          initial={{ opacity: 0, scale: 0.92, y: -2 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={spring}
        >
          <button
            type="button"
            className="compact-button"
            data-drag-region="true"
            onClick={onClickPill}
            aria-label="Open Agent Island"
          >
            <span className="compact-leading" data-drag-region="true">
              <HermesMark />
              <StatusDot status={hasApproval ? 'waiting' : active.status} />
            </span>

            <span className="compact-copy" data-drag-region="true">
              <span className="compact-title">
                {hasApproval ? 'Approval needed' : active.label}
              </span>
              <span className="compact-subtitle">
                {hasApproval
                  ? `${queueCount} request${queueCount === 1 ? '' : 's'} waiting`
                  : active.activityLabel || 'Listening'}
              </span>
            </span>

            <span className="compact-trailing" data-drag-region="true">
              {hasApproval ? <span className="approval-count">{queueCount}</span> : <ActivityGlyph />}
              <span className="compact-expand"><ChevronIcon /></span>
            </span>
          </button>
        </motion.div>
      </AnimatePresence>
    )
  }

  if (state.mode === 'approval' && approval) {
    return (
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          layout
          key={`approval-${approval.id}-${attentionNonce}`}
          className={`island-surface expanded-island approval-island needs-attention ${dockClass}`}
          role="dialog"
          aria-label="Approval required"
          initial={{ opacity: 0, scale: 0.9, y: -4 }}
          animate={{ opacity: 1, scale: [0.97, 1.012, 1], y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -3 }}
          transition={{ ...spring, scale: { duration: 0.48, times: [0, 0.55, 1] } }}
        >
          <div className="island-header approval-header" data-drag-region="true">
            <div className="brand-lockup" data-drag-region="true">
              <span className="header-mark-wrap">
                <HermesMark compact />
                <StatusDot status="waiting" />
              </span>
              <span className="header-copy" data-drag-region="true">
                <strong>Hermes needs approval</strong>
                <small>Paused until you decide</small>
              </span>
            </div>

            <div className="approval-header-actions">
              {queueCount > 1 ? <span className="floating-count">{queueCount}</span> : null}
              <button
                type="button"
                className="icon-button"
                data-no-drag="true"
                onClick={onCollapse}
                aria-label="Collapse"
              >
                <CloseIcon />
              </button>
            </div>
          </div>

          <motion.div
            className="approval-notice"
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.06, duration: 0.2 }}
          >
            <span className="notice-icon"><AlertIcon /></span>
            <span>
              <strong>Review this action</strong>
              <small>The agent will continue only after your approval.</small>
            </span>
          </motion.div>

          <ApprovalCard
            approval={approval}
            approveEnabled={approveEnabled}
            onApprove={onApprove}
            onDeny={onDeny}
          />
        </motion.div>
      </AnimatePresence>
    )
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        layout
        key={`open-${state.mode}`}
        className={`island-surface expanded-island mode-${state.mode} ${dockClass}`}
        role="dialog"
        aria-label="Agent Island"
        initial={{ opacity: 0, scale: 0.92, y: -3 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: -3 }}
        transition={spring}
      >
        <div className="island-header" data-drag-region="true">
          <div className="brand-lockup" data-drag-region="true">
            <span className="header-mark-wrap">
              <HermesMark compact />
              <StatusDot status={hasApproval ? 'waiting' : active.status} />
            </span>
            <span className="header-copy" data-drag-region="true">
              <strong>{active.label}</strong>
              <small>{active.activityLabel || 'Listening'}</small>
            </span>
          </div>

          <AgentTabs
            agents={AGENT_ORDER.map((id) => state.agents[id])}
            activeAgentId={state.activeAgentId}
            onSelect={onSelectAgent}
          />

          <div className="header-actions">
            {hasApproval ? <span className="floating-count">{queueCount}</span> : null}
            <button
              type="button"
              className="icon-button"
              data-no-drag="true"
              onClick={onCollapse}
              aria-label="Collapse"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        <motion.div
          className={`status-card ${state.mode === 'error' ? 'error-card' : ''}`}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.2 }}
        >
          {state.mode === 'error' ? (
            <>
              <span className="state-icon error"><AlertIcon /></span>
              <span className="status-copy">
                <strong>Something needs attention</strong>
                <small>{state.message ?? 'Something went wrong'}</small>
              </span>
              <button type="button" className="text-button" data-no-drag="true" onClick={onDismiss}>
                Dismiss
              </button>
            </>
          ) : state.mode === 'success' ? (
            <>
              <span className="state-icon success"><CheckIcon /></span>
              <span className="status-copy">
                <strong>Approved</strong>
                <small>{state.message ?? 'Hermes is continuing.'}</small>
              </span>
            </>
          ) : (
            <>
              <span className="state-icon listening"><ActivityGlyph waiting={hasApproval} /></span>
              <span className="status-copy">
                <strong>{hasApproval ? 'A decision is waiting' : 'Ready in the background'}</strong>
                <small>
                  {hasApproval
                    ? 'Open the request to approve or deny it.'
                    : 'Agent Island will expand automatically when Hermes needs you.'}
                </small>
                <em>{statusNote}</em>
              </span>
            </>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
