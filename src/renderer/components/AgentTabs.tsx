import type { AgentId, AgentSnapshot } from '@shared/contracts'
import { StatusDot } from './StatusDot'

interface AgentTabsProps {
  agents: AgentSnapshot[]
  activeAgentId: AgentId
  onSelect: (agentId: AgentId) => void
}

export function AgentTabs({ agents, activeAgentId, onSelect }: AgentTabsProps) {
  const visibleAgents = agents.filter(
    (agent) => agent.available || agent.id === activeAgentId || agent.pendingApprovalIds.length > 0
  )

  if (visibleAgents.length <= 1) return null

  return (
    <div className="tabs" role="tablist" aria-label="Agents" data-no-drag="true">
      {visibleAgents.map((agent) => {
        const active = agent.id === activeAgentId
        return (
          <button
            key={agent.id}
            type="button"
            role="tab"
            data-no-drag="true"
            aria-selected={active}
            className={`tab ${active ? 'active' : ''}`}
            onClick={() => onSelect(agent.id)}
          >
            <StatusDot status={agent.status} />
            <span>{agent.label}</span>
            {agent.pendingApprovalIds.length > 0 ? (
              <span className="tab-badge">{agent.pendingApprovalIds.length}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
