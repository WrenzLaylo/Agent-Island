import type { AgentId } from '@shared/contracts'

interface AgentMarkProps {
  agentId: AgentId
  compact?: boolean
  mini?: boolean
  className?: string
}

/**
 * Official marks, discovered at build time.
 *
 * Anything dropped into `assets/agents/<agentId>.svg` replaces that agent's
 * letter with no code change. The glob is eager and inlined as source rather
 * than imported as a URL, so the SVG can inherit `currentColor` from the
 * per-agent colour in globals.css — an <img> could not.
 *
 * Deliberately not hand-drawn. These are trademarks, and an approximation of
 * a mark this recognisable reads as wrong to anyone who knows it.
 */
const marks = import.meta.glob('../assets/agents/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default'
}) as Record<string, string>

const AGENT_NAMES: AgentId[] = ['claude', 'codex', 'hermes']

const markByAgent: Partial<Record<AgentId, string>> = {}
for (const [path, source] of Object.entries(marks)) {
  const name = path.split('/').pop()?.replace('.svg', '')
  const agentId = AGENT_NAMES.find((candidate) => candidate === name)
  if (agentId) markByAgent[agentId] = source
}

/** Fallback for any agent with no mark on disk. */
const glyphs: Record<AgentId, string> = {
  claude: 'C',
  codex: '<>',
  hermes: 'H'
}

export function AgentMark({ agentId, compact = false, mini = false, className = '' }: AgentMarkProps) {
  const mark = markByAgent[agentId]
  return (
    <span
      className={`agent-mark agent-mark-${agentId} ${compact ? 'mark-compact' : ''} ${mini ? 'mark-mini' : ''} ${className}`.trim()}
      aria-hidden="true"
    >
      {mark ? (
        // A build-time asset, never runtime input.
        <span className="agent-logo" dangerouslySetInnerHTML={{ __html: mark }} />
      ) : (
        <span className="agent-glyph">{glyphs[agentId]}</span>
      )}
    </span>
  )
}
