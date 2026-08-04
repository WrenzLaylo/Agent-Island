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

function shortenCommand(cmd: string, max = 900): string {
  const t = cmd.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}…`
}

export function ApprovalCard({ approval, approveEnabled, onApprove, onDeny }: ApprovalCardProps) {
  const why = approval.riskReason?.trim()
  const cwd = approval.cwd?.trim()

  return (
    <div className={`approval-card risk-${approval.risk}`}>
      <div className="approval-top">
        <div className="approval-eyebrow">Needs your confirmation</div>
        <span className={`risk-pill ${approval.risk}`}>{riskLabel(approval.risk)}</span>
      </div>

      <pre className="approval-detail" title={approval.detail}>
        {shortenCommand(approval.detail)}
      </pre>

      <div className="approval-meta">
        {why ? (
          <div className="meta-row">
            <span className="meta-key">Why</span>
            <span className="meta-val">{why}</span>
          </div>
        ) : null}
        {cwd ? (
          <div className="meta-row">
            <span className="meta-key">cwd</span>
            <span className="meta-val mono">{cwd}</span>
          </div>
        ) : null}
      </div>

      {!approveEnabled && (
        <div className="warn">This request looks stale — deny and re-run if needed.</div>
      )}

      <div className="approval-actions">
        <button type="button" className="btn deny" onClick={onDeny}>
          Deny
        </button>
        <button
          type="button"
          className="btn approve"
          onClick={onApprove}
          disabled={!approveEnabled}
        >
          Approve once
        </button>
      </div>
    </div>
  )
}
