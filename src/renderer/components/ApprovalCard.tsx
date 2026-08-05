import { motion } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '@shared/contracts'

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

function choiceLabel(choice: ApprovalDecision, approval: ApprovalRequest): string {
  switch (choice) {
    case 'session':
      return 'Allow for this session'
    case 'always':
      return approval.source === 'codex-terminal' ? "Don't ask again" : 'Add to permanent allowlist'
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
      return approval.source === 'codex-terminal'
        ? 'Codex may persist a matching command-prefix rule across future sessions'
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

  const choose = (choice: ApprovalDecision) => {
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
            <strong>{approval.source === 'codex-terminal' ? "Stop asking for matching Codex commands?" : 'Allow matching commands automatically?'}</strong>
            <small>{approval.source === 'codex-terminal'
              ? 'Codex may save a broad command-prefix rule that remains active in future sessions and workspaces. Confirm only when you understand the displayed scope.'
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
              disabled={!approveEnabled || disabled}
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
            const buttonDisabled = disabled || (!isDeny && !approveEnabled)
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
