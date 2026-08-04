import type { AgentId, AgentSnapshot } from '@shared/contracts'
import { StatusDot } from './StatusDot'

interface AgentTabsProps {
  agents: AgentSnapshot[]
  activeAgentId: AgentId
  onSelect: (agentId: AgentId) => void
}

export function AgentTabs({ agents, activeAgentId, onSelect }: AgentTabsProps) {
  return (
    <div className="tabs" role="tablist" aria-label="Agents">
      {agents.map((agent) => {
        const active = agent.id === activeAgentId
        return (
          <button
            key={agent.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`tab ${active ? 'active' : ''} ${agent.available ? '' : 'missing'}`}
            onClick={() => onSelect(agent.id)}
          >
            <StatusDot status={agent.status} />
            <span>{agent.label}</span>
            {agent.pendingApprovalIds.length > 0 && (
              <span className="tab-badge">{agent.pendingApprovalIds.length}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
