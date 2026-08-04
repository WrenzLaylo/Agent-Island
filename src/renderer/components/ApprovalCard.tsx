import type { ApprovalRequest } from '@shared/contracts'

interface ApprovalCardProps {
  approval: ApprovalRequest
  approveEnabled: boolean
  onApprove: () => void
  onDeny: () => void
}

export function ApprovalCard({ approval, approveEnabled, onApprove, onDeny }: ApprovalCardProps) {
  return (
    <div className={`approval-card risk-${approval.risk}`}>
      <div className="approval-kicker">
        {approval.agentId.toUpperCase()} wants permission
        <span className={`risk-pill ${approval.risk}`}>{approval.risk}</span>
      </div>
      <h2 className="approval-title">{approval.summary}</h2>
      <pre className="approval-detail">{approval.detail}</pre>
      <div className="muted tiny">cwd: {approval.cwd}</div>
      {approval.riskReason && <div className="risk-reason">{approval.riskReason}</div>}
      {!approveEnabled && (
        <div className="warn">Approve disabled — open the terminal if this looks stale or unknown.</div>
      )}
      <div className="approval-actions">
        <button type="button" className="danger" onClick={onDeny}>
          Deny
        </button>
        <button type="button" className="primary" onClick={onApprove} disabled={!approveEnabled}>
          Approve once
        </button>
      </div>
    </div>
  )
}
