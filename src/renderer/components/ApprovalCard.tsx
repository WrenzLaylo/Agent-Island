import { motion } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import { APPROVAL_REARM_MS, approvalReArmed } from '@shared/approval-guard'
import { AGENT_LABELS, type ApprovalDecision, type ApprovalRequest } from '@shared/contracts'

interface ApprovalCardProps {
  approval: ApprovalRequest
  approveEnabled: boolean
  disabled?: boolean
  onDecision: (decision: ApprovalDecision) => void
}

function riskLabel(risk: ApprovalRequest['risk']): string {
  switch (risk) {
    case 'high':
      return 'High risk'
    case 'elevated':
      return 'Elevated risk'
    case 'low':
      return 'Low risk'
    default:
      return 'Review carefully'
  }
}

function shortenCommand(command: string, max = 1200): string {
  const trimmed = command.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

const CHOICE_ORDER: ApprovalDecision[] = ['once', 'session', 'always', 'deny']

/**
 * Wording follows the agent that raised the request. It used to key off
 * `source === 'codex-terminal'`, which meant every non-Hermes agent — Claude
 * included — was described to the user as Codex.
 */
function agentLabel(approval: ApprovalRequest): string {
  return AGENT_LABELS[approval.agentId]
}

/** Agents that persist a command-prefix rule rather than a literal allowlist. */
function persistsPrefixRule(approval: ApprovalRequest): boolean {
  return approval.agentId === 'codex' || approval.agentId === 'claude'
}

function choiceLabel(choice: ApprovalDecision, approval: ApprovalRequest): string {
  switch (choice) {
    case 'session':
      return 'Allow for this session'
    case 'always':
      return persistsPrefixRule(approval) ? "Don't ask again" : 'Add to permanent allowlist'
    case 'deny':
      return 'Deny'
    default:
      return 'Allow once'
  }
}

function choiceHint(choice: ApprovalDecision, approval: ApprovalRequest): string {
  switch (choice) {
    case 'session':
      return 'Remember until this agent session ends'
    case 'always':
      return persistsPrefixRule(approval)
        ? `${agentLabel(approval)} may persist a matching command-prefix rule across future sessions`
        : 'Automatically allow matching commands in future sessions'
    case 'deny':
      return 'Block this action and return control to the agent'
    default:
      return 'Run this action one time only'
  }
}

function DecisionIcon({ choice }: { choice: ApprovalDecision }) {
  if (choice === 'deny') return <span aria-hidden="true">×</span>
  if (choice === 'session') return <span aria-hidden="true">◷</span>
  if (choice === 'always') return <span aria-hidden="true">◇</span>
  return <span aria-hidden="true">✓</span>
}

export function ApprovalCard({ approval, approveEnabled, disabled = false, onDecision }: ApprovalCardProps) {
  const [confirmPermanent, setConfirmPermanent] = useState(false)
  const choices = useMemo(
    () => CHOICE_ORDER.filter((choice) => (approval.choices?.length ? approval.choices : ['once', 'deny']).includes(choice)),
    [approval.choices]
  )

  useEffect(() => setConfirmPermanent(false), [approval.id])

  /**
   * Answering one approval promotes the next queued one into this same card,
   * so the buttons stay inert briefly whenever the request id changes. Without
   * it, the second half of an accidental double-click answers a request the
   * user has not read yet — see APPROVAL_REARM_MS.
   */
  const [armed, setArmed] = useState(false)
  const shownAtRef = useRef(0)
  useEffect(() => {
    shownAtRef.current = Date.now()
    setArmed(false)
    const timer = window.setTimeout(() => setArmed(true), APPROVAL_REARM_MS)
    return () => window.clearTimeout(timer)
  }, [approval.id])

  const inert = disabled || !armed

  const choose = (choice: ApprovalDecision) => {
    // The disabled attribute already covers pointer clicks; this also refuses
    // keyboard activation and anything that replays an event into the card.
    if (!approvalReArmed(shownAtRef.current, Date.now())) return
    if (choice === 'always') {
      setConfirmPermanent(true)
      return
    }
    onDecision(choice)
  }

  return (
    <div className={`approval-card risk-${approval.risk}`}>
      {/* The panel header already states "Approval required" and names the
          agent, so this row carries only the request-specific summary and the
          risk verdict. */}
      <div className="approval-summary-row">
        <div className="approval-summary-copy">
          <strong>{approval.summary || 'Command approval'}</strong>
        </div>
        <span className={`risk-pill risk-${approval.risk}`}>{riskLabel(approval.risk)}</span>
      </div>

      <div className="command-block">
        <span className="command-label">Command</span>
        <pre title={approval.detail}>{shortenCommand(approval.detail)}</pre>
      </div>

      <div className="approval-context">
        {approval.cwd ? (
          <div><span>Folder</span><code>{approval.cwd}</code></div>
        ) : null}
        {approval.riskReason ? (
          <div><span>Flagged</span><p>{approval.riskReason}</p></div>
        ) : null}
      </div>

      {!approveEnabled ? (
        <div className="stale-warning" role="status">
          This request is no longer safe to approve. Deny it or reopen the action from the agent.
        </div>
      ) : null}

      {confirmPermanent ? (
        <motion.div
          className="permanent-confirmation"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div>
            <strong>{persistsPrefixRule(approval) ? `Stop asking for matching ${agentLabel(approval)} commands?` : 'Allow matching commands automatically?'}</strong>
            <small>{persistsPrefixRule(approval)
              ? `${agentLabel(approval)} may save a broad command-prefix rule that remains active in future sessions and workspaces. Confirm only when you understand the displayed scope.`
              : 'This permission can apply in future sessions. Only confirm when you trust this command pattern.'}</small>
          </div>
          <div className="permanent-actions">
            <button type="button" className="quiet-button" data-no-drag="true" onClick={() => setConfirmPermanent(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="permanent-button"
              data-no-drag="true"
              disabled={!approveEnabled || inert}
              onClick={() => onDecision('always')}
            >
              Confirm permanent access
            </button>
          </div>
        </motion.div>
      ) : (
        <div className={`decision-list choices-${choices.length}`}>
          {choices.map((choice) => {
            const isDeny = choice === 'deny'
            const buttonDisabled = inert || (!isDeny && !approveEnabled)
            return (
              <motion.button
                key={choice}
                type="button"
                className={`decision-button decision-${choice}`}
                data-no-drag="true"
                onClick={() => choose(choice)}
                disabled={buttonDisabled}
                whileTap={!buttonDisabled ? { scale: 0.985 } : undefined}
              >
                <span className="decision-icon"><DecisionIcon choice={choice} /></span>
                <span className="decision-copy"><strong>{choiceLabel(choice, approval)}</strong><small>{choiceHint(choice, approval)}</small></span>
              </motion.button>
            )
          })}
        </div>
      )}
    </div>
  )
}
