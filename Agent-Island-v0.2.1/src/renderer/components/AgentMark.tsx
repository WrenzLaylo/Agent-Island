import type { AgentId } from '@shared/contracts'

interface AgentMarkProps {
  agentId: AgentId
  compact?: boolean
  mini?: boolean
  className?: string
}

const glyphs: Record<AgentId, string> = {
  claude: 'C',
  codex: '<>',
  hermes: 'H'
}

export function AgentMark({ agentId, compact = false, mini = false, className = '' }: AgentMarkProps) {
  return (
    <span
      className={`agent-mark agent-mark-${agentId} ${compact ? 'mark-compact' : ''} ${mini ? 'mark-mini' : ''} ${className}`.trim()}
      aria-hidden="true"
    >
      <span className="agent-glyph">{glyphs[agentId]}</span>
      <span className="mark-sheen" />
    </span>
  )
}
