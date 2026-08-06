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
import { CloseIcon, GearIcon, TerminalIcon } from './icons'

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
  onContinueInTerminal: (agentId: AgentId, sessionId?: string) => void
  onOpenTerminal: (agentId: AgentId) => void
  onDismiss: () => void
  onOpenSettings: () => void
  onClosePanel: () => void
  onSettingsChange: (patch: Partial<IslandSettings>) => void
  onCompleteOnboarding: () => void
  onReturnHome: () => void
}

function ActivityGlyph({ waiting = false }: { waiting?: boolean }) {
  return (
    <span className={`activity-glyph ${waiting ? 'is-waiting' : ''}`} aria-hidden="true">
      <i /><i /><i />
    </span>
  )
}

/**
 * Deliberately name-free: the agent's name is already the header title, so
 * repeating it here ("Claude" / "Claude is ready" / "Installed and ready" all
 * on one 172px panel) was three restatements of one fact.
 */
function statusHeadline(active: AgentSnapshot): string {
  switch (active.status) {
    case 'running':
    case 'thinking':
      return 'Working'
    case 'waiting':
      return 'Needs you'
    case 'completed':
      return 'Finished'
    case 'error':
      return 'Needs attention'
    case 'offline':
      return 'Unavailable'
    default:
      return 'Ready'
  }
}

/** The supporting line must add a fact, not restate the headline. */
function statusDescription(active: AgentSnapshot): string {
  if (!active.available) return 'Install or sign in to this agent to make it available.'
  switch (active.status) {
    case 'running':
    case 'thinking':
      return active.activityLabel || 'Working in the background.'
    case 'waiting':
      return 'A decision is waiting in the approval queue.'
    case 'completed':
      return 'The last session exited cleanly.'
    case 'error':
      return active.lastError || 'The last session ended unexpectedly.'
    default:
      return 'No session running. Approvals will appear here.'
  }
}

/** Motion only where something is genuinely in flight. */
function showsActivity(status: AgentSnapshot['status']): boolean {
  return status === 'running' || status === 'thinking' || status === 'waiting'
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

/**
 * The OS window is the only thing that animates geometry (see `animateIslandTo`
 * in the main process). Content therefore does not move or scale — it only
 * cross-fades, so what the user reads is always flush with the real frame.
 * Views overlap during the fade (`.island-content` is absolutely positioned)
 * rather than queueing exit-then-enter, which used to take ~470ms against a
 * ~250ms window morph and made the transition feel like two separate events.
 */
function contentFade(enter: number, exit: number) {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0, transition: { duration: exit } },
    transition: { duration: enter }
  }
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
  const fade = contentFade(settings.reducedMotion ? 0.01 : 0.16, settings.reducedMotion ? 0.01 : 0.1)

  return (
    <section
      className={`island-surface view-${view} ${hasAttention ? 'has-attention' : ''} ${quietIdle ? 'is-quiet-idle' : ''} ${isMorphing ? 'is-morphing' : ''}`}
      data-drag-region="true"
      data-mode={view}
    >
      {/* Announce only the state sentence, not the whole subtree — an aria-live
          region wrapped around the entire island re-read every control on every
          render. */}
      <span className="sr-only" role="status" aria-live="polite">
        {hasApproval
          ? `Approval required from ${approvalAgent.label}. ${queueCount} pending.`
          : hasTerminalInput
            ? `${active.label} needs input in the terminal.`
            : `${active.label}: ${statusHeadline(active)}`}
      </span>
      <AnimatePresence initial={false}>
        {hasAttention ? (
          <motion.span
            key={`attention-${attentionNonce}`}
            className="attention-flash"
            initial={{ opacity: 0.6 }}
            animate={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: settings.reducedMotion ? 0.01 : 0.75, ease: 'easeOut' }}
            aria-hidden="true"
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {isDockOrb ? (
          <motion.button
            key="dock"
            type="button"
            className="dock-button"
            data-drag-region="true"
            onClick={onClickPill}
            aria-label={`Open Agent Island. ${hasApproval ? `${queueCount} approvals waiting.` : `${active.label} ${active.activityLabel}.`}`}
            {...fade}
          >
            {quietIdle ? null : (
              <>
                <span className={`dock-status-ring status-${hasApproval ? 'waiting' : active.status}`} />
                <AgentMark agentId={active.id} mini />
                {/* The badge has to stay round to fit inside the disc, so the
                    count is capped rather than allowed to widen it. */}
                {hasApproval ? <span className="dock-badge">{queueCount > 9 ? '9+' : queueCount}</span> : null}
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
            {...fade}
          >
            {quietIdle ? (
              <span className="quiet-idle-hit-area" aria-hidden="true" />
            ) : (
              <>
                <span className="compact-leading" data-drag-region="true">
                  <AgentMark agentId={hasApproval && approval ? approval.agentId : active.id} compact />
                  <StatusDot status={hasApproval ? 'waiting' : active.status} />
                </span>
                <span className="compact-copy" data-drag-region="true">
                  {/* The count lives in the trailing chip; repeating it here as
                      "1 pending" said the same thing twice on one 300px pill. */}
                  <strong>{hasApproval ? 'Approval required' : active.label}</strong>
                  <small>{hasApproval ? approvalAgent.label : active.activityLabel || 'Ready'}</small>
                </span>
                <span className="compact-trailing" data-drag-region="true">
                  {hasApproval ? (
                    <span className="compact-count">{queueCount}</span>
                  ) : showsActivity(active.status) ? (
                    <ActivityGlyph waiting={active.status === 'waiting'} />
                  ) : (
                    <StatusDot status={active.status} />
                  )}
                </span>
              </>
            )}
          </motion.button>
        ) : panel === 'onboarding' ? (
          <motion.div key="onboarding" className="island-content" {...fade}>
            <OnboardingCard onComplete={onCompleteOnboarding} />
          </motion.div>
        ) : panel === 'settings' ? (
          <motion.div key="settings" className="island-content" {...fade}>
            <SettingsPanel settings={settings} onChange={onSettingsChange} onClose={onClosePanel} onReturnHome={onReturnHome} />
          </motion.div>
        ) : panel === 'handoff' && terminalInput ? (
          <motion.div
            key={`handoff-${terminalInput.id}`}
            className="island-content handoff-view"
            {...fade}
            role="dialog"
            aria-label={`${state.agents[terminalInput.agentId].label} needs input in the terminal`}
          >
            <div className="panel-header handoff-header" data-drag-region="true">
              <div className="header-agent">
                <span className="header-mark-wrap"><AgentMark agentId={terminalInput.agentId} compact /><StatusDot status="waiting" /></span>
                <span>
                  <strong>{state.agents[terminalInput.agentId].label} needs input</strong>
                  <small>{terminalInput.terminalLabel ?? 'Terminal'}</small>
                </span>
              </div>
              <button type="button" className="icon-button" data-no-drag="true" onClick={onCollapse} aria-label="Collapse">
                <CloseIcon />
              </button>
            </div>
            <div className="handoff-body">
              <p>{terminalInput.detail?.split('\n')[0] || terminalInput.title}</p>
              {terminalInput.canRaiseWindow === false ? (
                <p className="handoff-note">
                  {terminalInput.terminalLabel ?? 'This terminal'} does not expose a window Agent
                  Island can raise. Switch to it yourself to answer.
                </p>
              ) : (
                <button
                  type="button"
                  className="terminal-handoff-button"
                  data-no-drag="true"
                  disabled={isMorphing}
                  /* The *session* id, not the prompt id — handoff raises the
                     window hosting the session, and the prompt is answered in
                     the terminal, not here. */
                  onClick={() => onContinueInTerminal(terminalInput.agentId, terminalInput.sessionId)}
                >
                  <TerminalIcon />
                  <span>
                    <strong>Continue in Terminal</strong>
                    <small>Bring {terminalInput.terminalLabel ?? 'the terminal'} to the front</small>
                  </span>
                </button>
              )}
            </div>
          </motion.div>
        ) : state.mode === 'approval' && approval ? (
          <motion.div
            key={`approval-${approval.id}-${attentionNonce}`}
            className="island-content approval-view"
            {...fade}
            role="dialog"
            aria-label="Approval required"
          >
            <div className="panel-header approval-panel-header" data-drag-region="true">
              <div className="header-agent">
                <span className="header-mark-wrap"><AgentMark agentId={approval.agentId} compact /><StatusDot status="waiting" /></span>
                <span><strong>Approval required</strong><small>{queueCount > 1 ? `${approvalAgent.label} · oldest of ${queueCount}` : approvalAgent.label}</small></span>
              </div>
              <button type="button" className="icon-button" data-no-drag="true" onClick={onCollapse} aria-label="Collapse approval">
                <CloseIcon />
              </button>
            </div>
            <ApprovalCard approval={approval} approveEnabled={approveEnabled} disabled={isMorphing} onDecision={onDecision} />
          </motion.div>
        ) : state.mode === 'success' || state.mode === 'error' ? (
          <motion.div key={`transient-${state.transientKind}`} className="island-content transient-view" {...fade}>
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
          <motion.div key="peek" className="island-content overview-view" {...fade}>
            <div className="panel-header" data-drag-region="true">
              <div className="header-agent">
                <span className="header-mark-wrap"><AgentMark agentId={active.id} compact /><StatusDot status={active.status} /></span>
                <span><strong>{active.label}</strong></span>
              </div>
              <div className="panel-actions">
                {hasApproval ? <span className="pending-chip">{queueCount}</span> : null}
                <button type="button" className="icon-button" data-no-drag="true" onClick={() => onOpenTerminal(active.id)} disabled={!active.available} aria-label={`Open ${active.label} terminal`}><TerminalIcon /></button>
                <button type="button" className="icon-button" data-no-drag="true" onClick={onOpenSettings} aria-label="Open settings"><GearIcon /></button>
                <button type="button" className="icon-button" data-no-drag="true" onClick={onCollapse} aria-label="Collapse"><CloseIcon /></button>
              </div>
            </div>

            <div className="overview-body">
              <span className="overview-status">
                {showsActivity(active.status) ? <ActivityGlyph waiting={active.status === 'waiting'} /> : null}
                <strong>{statusHeadline(active)}</strong>
              </span>
              <small>{statusDescription(active)}</small>
              {settings.developerDiagnostics ? (
                <span className="diagnostics-row">
                  <span>{active.integrationMode}</span>
                  <span>{active.version || 'version unavailable'}</span>
                  <span>{statusNote}</span>
                </span>
              ) : null}
            </div>

            <AgentTabs agents={AGENT_ORDER.map((id) => state.agents[id])} activeAgentId={state.activeAgentId} onSelect={onSelectAgent} />
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
