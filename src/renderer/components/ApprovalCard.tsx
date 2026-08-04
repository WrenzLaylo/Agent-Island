import { motion } from 'framer-motion'
import type { ApprovalRequest } from '@shared/contracts'

interface ApprovalCardProps {
  approval: ApprovalRequest
  approveEnabled: boolean
  onApprove: () => void
  onDeny: () => void
}

function riskLabel(risk: ApprovalRequest['risk']): string {
  switch (risk) {
    case 'high':
      return 'High risk'
    case 'elevated':
      return 'Elevated'
    case 'low':
      return 'Low risk'
    default:
      return 'Review'
  }
}

function shortenCommand(command: string, max = 900): string {
  const trimmed = command.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}…`
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DenyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function ApprovalCard({ approval, approveEnabled, onApprove, onDeny }: ApprovalCardProps) {
  const why = approval.riskReason?.trim()
  const cwd = approval.cwd?.trim()

  return (
    <div className={`approval-card risk-${approval.risk}`}>
      <div className="approval-title-row">
        <div className="approval-title-copy">
          <strong>{approval.summary || 'Command approval'}</strong>
          <small>Requested just now</small>
        </div>
        <span className={`risk-pill ${approval.risk}`}>{riskLabel(approval.risk)}</span>
      </div>

      <pre className="approval-detail" title={approval.detail}>
        {shortenCommand(approval.detail)}
      </pre>

      {why || cwd ? (
        <div className="approval-meta">
          {why ? (
            <div className="meta-row">
              <span className="meta-key">Why</span>
              <span className="meta-val">{why}</span>
            </div>
          ) : null}
          {cwd ? (
            <div className="meta-row">
              <span className="meta-key">Folder</span>
              <span className="meta-val mono">{cwd}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {!approveEnabled ? (
        <div className="stale-warning">This request may be stale. Deny it and run the action again.</div>
      ) : null}

      <div className="approval-actions">
        <motion.button
          type="button"
          className="action-button deny"
          data-no-drag="true"
          onClick={onDeny}
          whileTap={{ scale: 0.975 }}
        >
          <DenyIcon />
          Deny
        </motion.button>
        <motion.button
          type="button"
          className="action-button approve"
          data-no-drag="true"
          onClick={onApprove}
          disabled={!approveEnabled}
          whileTap={approveEnabled ? { scale: 0.975 } : undefined}
        >
          <CheckIcon />
          Approve once
        </motion.button>
      </div>
    </div>
  )
}
