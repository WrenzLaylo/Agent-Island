import type { AgentId, AgentSnapshot } from '@shared/contracts'
import { AgentMark } from './AgentMark'
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
    <div className="agent-switcher" role="tablist" aria-label="Available agents" data-no-drag="true">
      {visibleAgents.map((agent) => {
        const active = agent.id === activeAgentId
        return (
          <button
            key={agent.id}
            type="button"
            role="tab"
            data-no-drag="true"
            aria-selected={active}
            aria-label={`Switch to ${agent.label}`}
            className={`agent-switch ${active ? 'is-active' : ''}`}
            onClick={() => onSelect(agent.id)}
          >
            <AgentMark agentId={agent.id} mini />
            <span className="agent-switch-label">{agent.label}</span>
            <StatusDot status={agent.status} />
            {agent.pendingApprovalIds.length > 0 ? (
              <span className="agent-switch-badge">{agent.pendingApprovalIds.length}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
