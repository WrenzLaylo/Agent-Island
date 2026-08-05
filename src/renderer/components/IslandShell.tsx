import { AnimatePresence, motion } from 'framer-motion'
import type {
  AgentId,
  AgentSnapshot,
  ApprovalDecision,
  ApprovalRequest,
  DockSide,
  IslandSettings,
  IslandSnapshot,
  TerminalInputPrompt
} from '@shared/contracts'
import { AGENT_ORDER } from '@shared/contracts'
import { AgentMark } from './AgentMark'
import { AgentTabs } from './AgentTabs'
import { ApprovalCard } from './ApprovalCard'
import { OnboardingCard } from './OnboardingCard'
import { SettingsPanel } from './SettingsPanel'
import { StatusDot } from './StatusDot'

export type IslandPanel = 'settings' | 'onboarding' | 'handoff' | null

interface IslandShellProps {
  state: IslandSnapshot
  active: AgentSnapshot
  approval?: ApprovalRequest
  terminalInput?: TerminalInputPrompt
  queueCount: number
  approveEnabled: boolean
  statusNote: string
  docked: DockSide | null
  attentionNonce: number
  panel: IslandPanel
  settings: IslandSettings
  isMorphing: boolean
  quietIdle: boolean
  onSelectAgent: (agentId: AgentId) => void
  onClickPill: () => void
  onCollapse: () => void
  onDecision: (decision: ApprovalDecision) => void
  onContinueInTerminal: (agentId: AgentId, promptId?: string) => void
  onOpenTerminal: (agentId: AgentId) => void
  onDismiss: () => void
  onOpenSettings: () => void
  onClosePanel: () => void
  onSettingsChange: (patch: Partial<IslandSettings>) => void
  onCompleteOnboarding: () => void
  onReturnHome: () => void
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m9.5 7 5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a7 7 0 0 0-1.8-1L14.4 3h-4.8l-.4 3.1a7 7 0 0 0-1.8 1l-2.4-1-2 3.4L5 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 1.8 1l.4 3.1h4.8l.4-3.1a7 7 0 0 0 1.8-1l2.4 1 2-3.4L19 13a7 7 0 0 0 .1-1Z" stroke="currentColor" strokeWidth="1.45" strokeLinejoin="round" />
    </svg>
  )
}

function TerminalIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="m7.5 9 3 3-3 3M13 15h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m8 8 8 8M16 8l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function ActivityGlyph({ waiting = false }: { waiting?: boolean }) {
  return (
    <span className={`activity-glyph ${waiting ? 'is-waiting' : ''}`} aria-hidden="true">
      <i /><i /><i />
    </span>
  )
}

function statusHeadline(active: AgentSnapshot): string {
  switch (active.status) {
    case 'running':
    case 'thinking':
      return `${active.label} is working`
    case 'waiting':
      return `${active.label} needs you`
    case 'completed':
      return `${active.label} finished`
    case 'error':
      return `${active.label} needs attention`
    case 'offline':
      return `${active.label} is unavailable`
    default:
      return `${active.label} is ready`
  }
}

function statusDescription(active: AgentSnapshot): string {
  if (!active.available) return 'Install or sign in to this agent to make it available.'
  if (active.status === 'running' || active.status === 'thinking') return active.activityLabel || 'Working in the background.'
  if (active.status === 'waiting') return 'A decision is waiting in the approval queue.'
  return active.activityLabel || 'Listening in the background.'
}

function transientTitle(state: IslandSnapshot): string {
  switch (state.transientKind) {
    case 'denied':
      return 'Request denied'
    case 'expired':
      return 'Request expired'
    case 'cancelled':
      return 'Request closed'
    case 'error':
      return 'Something needs attention'
    case 'completed':
      return 'Completed'
    default:
      return 'Permission granted'
  }
}

const contentTransition = {
  initial: { opacity: 0, y: 7, scale: 0.992 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -5, scale: 0.995 }
}

export function IslandShell(props: IslandShellProps) {
  const {
    state,
    active,
    approval,
    terminalInput,
    queueCount,
    approveEnabled,
    statusNote,
    docked,
    attentionNonce,
    panel,
    settings,
    isMorphing,
    quietIdle,
    onSelectAgent,
    onClickPill,
    onCollapse,
    onDecision,
    onContinueInTerminal,
    onOpenTerminal,
    onDismiss,
    onOpenSettings,
    onClosePanel,
    onSettingsChange,
    onCompleteOnboarding,
    onReturnHome
  } = props

  const hasApproval = queueCount > 0
  const hasTerminalInput = Boolean(terminalInput)
  const hasAttention = hasApproval || hasTerminalInput
  const isDockOrb = state.mode === 'collapsed' && Boolean(docked) && !panel
  const isCompact = state.mode === 'collapsed' && !docked && !panel
  const view = panel ?? (isDockOrb ? 'dock' : isCompact ? 'compact' : state.mode)
  const approvalAgent = approval ? state.agents[approval.agentId] : active
  const motionDuration = settings.reducedMotion ? 0.08 : 0.2

  return (
    <motion.section
      layout
      className={`island-surface view-${view} ${docked ? `anchored-${docked}` : ''} ${hasAttention ? 'has-attention' : ''} ${quietIdle ? 'is-quiet-idle' : ''} ${isMorphing ? 'is-morphing' : ''}`}
      data-drag-region="true"
      data-mode={view}
      aria-live="polite"
      transition={settings.reducedMotion ? { duration: 0.08 } : { type: 'spring', stiffness: 380, damping: 34, mass: 0.88 }}
    >
      <AnimatePresence initial={false}>
        {hasAttention ? (
          <motion.span
            key={`attention-${attentionNonce}`}
            className="attention-flash"
            initial={{ opacity: 0.72, scale: 0.985 }}
            animate={{ opacity: 0, scale: 1.015 }}
            exit={{ opacity: 0 }}
            transition={{ duration: settings.reducedMotion ? 0.08 : 0.9, ease: 'easeOut' }}
            aria-hidden="true"
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence mode="wait" initial={false}>
        {isDockOrb ? (
          <motion.button
            key="dock"
            type="button"
            className="dock-button"
            data-drag-region="true"
            onClick={onClickPill}
            aria-label={`Open Agent Island. ${hasApproval ? `${queueCount} approvals waiting.` : `${active.label} ${active.activityLabel}.`}`}
            {...contentTransition}
            transition={{ duration: motionDuration }}
          >
            {quietIdle ? null : (
              <>
                <AgentMark agentId={active.id} compact />
                <span className={`dock-status-ring status-${hasApproval ? 'waiting' : active.status}`} />
                {hasApproval ? <span className="dock-badge">{queueCount}</span> : null}
              </>
            )}
          </motion.button>
        ) : isCompact ? (
          <motion.button
            key="compact"
            type="button"
            className="compact-button"
            data-drag-region="true"
            onClick={onClickPill}
            aria-label="Open Agent Island"
            {...contentTransition}
            transition={{ duration: motionDuration }}
          >
            {quietIdle ? (
              <span className="quiet-idle-hit-area" aria-hidden="true" />
            ) : (
              <>
                <span className="compact-leading" data-drag-region="true">
                  <AgentMark agentId={hasApproval && approval ? approval.agentId : active.id} />
                  <StatusDot status={hasApproval ? 'waiting' : active.status} />
                </span>
                <span className="compact-copy" data-drag-region="true">
                  <strong>{hasApproval ? 'Approval required' : active.label}</strong>
                  <small>{hasApproval ? `${queueCount} pending · ${approvalAgent.label}` : active.activityLabel || 'Ready'}</small>
                </span>
                <span className="compact-trailing" data-drag-region="true">
                  {hasApproval ? <span className="compact-count">{queueCount}</span> : <ActivityGlyph waiting={active.status === 'waiting'} />}
                  <span className="compact-chevron"><ChevronIcon /></span>
                </span>
              </>
            )}
          </motion.button>
        ) : panel === 'onboarding' ? (
          <motion.div key="onboarding" className="island-content" {...contentTransition} transition={{ duration: motionDuration, delay: settings.reducedMotion ? 0 : 0.07 }}>
            <OnboardingCard onComplete={onCompleteOnboarding} />
          </motion.div>
        ) : panel === 'settings' ? (
          <motion.div key="settings" className="island-content" {...contentTransition} transition={{ duration: motionDuration, delay: settings.reducedMotion ? 0 : 0.07 }}>
            <SettingsPanel settings={settings} onChange={onSettingsChange} onClose={onClosePanel} onReturnHome={onReturnHome} />
          </motion.div>
        ) : panel === 'handoff' && terminalInput ? (
          <motion.div
            key={`handoff-${terminalInput.id}`}
            className="island-content handoff-view"
            {...contentTransition}
            transition={{ duration: motionDuration, delay: settings.reducedMotion ? 0 : 0.06 }}
            role="dialog"
            aria-label={`${state.agents[terminalInput.agentId].label} needs input in the terminal`}
          >
            <div className="panel-header handoff-header" data-drag-region="true">
              <div className="header-agent">
                <span className="header-mark-wrap"><AgentMark agentId={terminalInput.agentId} compact /><StatusDot status="waiting" /></span>
                <span><strong>{terminalInput.title}</strong><small>Complete this step in the managed terminal.</small></span>
              </div>
              <button type="button" className="icon-button" data-no-drag="true" onClick={onCollapse} aria-label="Collapse">
                <CloseIcon />
              </button>
            </div>
            <div className="handoff-body">
              <p>{terminalInput.detail?.split('\n')[0] || 'This prompt has choices or typed input that Agent Island should not answer automatically.'}</p>
              <button
                type="button"
                className="terminal-handoff-button"
                data-no-drag="true"
                disabled={isMorphing}
                onClick={() => onContinueInTerminal(terminalInput.agentId, terminalInput.id)}
              >
                <TerminalIcon />
                <span><strong>Continue in Terminal</strong><small>Move it to this display and focus the prompt</small></span>
              </button>
            </div>
          </motion.div>
        ) : state.mode === 'approval' && approval ? (
          <motion.div
            key={`approval-${approval.id}-${attentionNonce}`}
            className="island-content approval-view"
            {...contentTransition}
            transition={{ duration: motionDuration, delay: settings.reducedMotion ? 0 : 0.08 }}
            role="dialog"
            aria-label="Approval required"
          >
            <div className="panel-header approval-panel-header" data-drag-region="true">
              <div className="header-agent">
                <span className="header-mark-wrap"><AgentMark agentId={approval.agentId} compact /><StatusDot status="waiting" /></span>
                <span><strong>Approval required</strong><small>{queueCount > 1 ? `${queueCount} pending · reviewing the oldest request` : `${approvalAgent.label} is paused`}</small></span>
              </div>
              <button type="button" className="icon-button" data-no-drag="true" onClick={onCollapse} aria-label="Collapse approval">
                <CloseIcon />
              </button>
            </div>
            <ApprovalCard approval={approval} approveEnabled={approveEnabled} disabled={isMorphing} onDecision={onDecision} />
          </motion.div>
        ) : state.mode === 'success' || state.mode === 'error' ? (
          <motion.div key={`transient-${state.transientKind}`} className="island-content transient-view" {...contentTransition} transition={{ duration: motionDuration }}>
            <div className={`transient-symbol kind-${state.transientKind ?? 'approved'}`} aria-hidden="true">
              {state.transientKind === 'error' || state.transientKind === 'expired' || state.transientKind === 'cancelled' ? '!' : state.transientKind === 'denied' ? '×' : '✓'}
            </div>
            <div className="transient-copy">
              <strong>{transientTitle(state)}</strong>
              <small>{state.message ?? 'The agent is continuing.'}</small>
              <em>{queueCount ? 'Opening the next approval…' : 'Returning to the pill…'}</em>
            </div>
            {state.transientKind === 'error' ? (
              <button type="button" className="quiet-button" data-no-drag="true" onClick={onDismiss}>Dismiss</button>
            ) : null}
          </motion.div>
        ) : (
          <motion.div key="peek" className="island-content overview-view" {...contentTransition} transition={{ duration: motionDuration, delay: settings.reducedMotion ? 0 : 0.07 }}>
            <div className="panel-header" data-drag-region="true">
              <div className="header-agent">
                <span className="header-mark-wrap"><AgentMark agentId={active.id} compact /><StatusDot status={active.status} /></span>
                <span><strong>{active.label}</strong><small>{active.activityLabel || 'Ready'}</small></span>
              </div>
              <AgentTabs agents={AGENT_ORDER.map((id) => state.agents[id])} activeAgentId={state.activeAgentId} onSelect={onSelectAgent} />
              <div className="panel-actions">
                {hasApproval ? <span className="pending-chip">{queueCount} pending</span> : null}
                <button type="button" className="icon-button" data-no-drag="true" onClick={() => onOpenTerminal(active.id)} disabled={!active.available} aria-label={`Open ${active.label} terminal`}><TerminalIcon /></button>
                <button type="button" className="icon-button" data-no-drag="true" onClick={onOpenSettings} aria-label="Open settings"><GearIcon /></button>
                <button type="button" className="icon-button" data-no-drag="true" onClick={onCollapse} aria-label="Collapse"><CloseIcon /></button>
              </div>
            </div>

            <div className={`agent-status-card status-${active.status}`}>
              <span className="status-activity"><ActivityGlyph waiting={active.status === 'waiting'} /></span>
              <span className="agent-status-copy"><strong>{statusHeadline(active)}</strong><small>{statusDescription(active)}</small></span>
            </div>

            {settings.developerDiagnostics ? (
              <div className="diagnostics-row">
                <span>{active.integrationMode}</span>
                <span>{active.version || 'version unavailable'}</span>
                <span>{statusNote}</span>
              </div>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  )
}
