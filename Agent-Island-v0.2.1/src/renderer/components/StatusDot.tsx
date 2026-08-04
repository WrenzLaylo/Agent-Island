import type { AgentStatus } from '@shared/contracts'

export function StatusDot({ status }: { status: AgentStatus }) {
  return <span className={`status-dot status-${status}`} aria-hidden="true" />
}
