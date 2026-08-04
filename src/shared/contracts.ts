export type AgentId = 'claude' | 'codex' | 'hermes'

export type AgentStatus =
  | 'offline'
  | 'idle'
  | 'thinking'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'error'

export type IntegrationMode =
  | 'structured'
  | 'terminal-known'
  | 'terminal-basic'
  | 'unavailable'
  | 'simulated'

export type IslandMode =
  | 'collapsed'
  | 'peek'
  | 'expanded'
  | 'approval'
  | 'success'
  | 'error'

export type RiskLevel = 'low' | 'elevated' | 'high' | 'unknown'

export interface ApprovalRequest {
  id: string
  agentId: AgentId
  summary: string
  detail: string
  cwd: string
  risk: RiskLevel
  riskReason?: string
  createdAt: number
  expiresAt: number
  processAlive: boolean
  waitingForInput: boolean
  answered: boolean
  superseded: boolean
}

export interface AgentSnapshot {
  id: AgentId
  label: string
  status: AgentStatus
  integrationMode: IntegrationMode
  activityLabel: string
  cwd: string
  available: boolean
  pendingApprovalIds: string[]
  lastError?: string
}

export interface IslandSnapshot {
  mode: IslandMode
  activeAgentId: AgentId
  agents: Record<AgentId, AgentSnapshot>
  approvals: Record<string, ApprovalRequest>
  approvalQueue: string[]
  hovered: boolean
  focused: boolean
  message?: string
}

export const AGENT_ORDER: AgentId[] = ['claude', 'codex', 'hermes']

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  hermes: 'Hermes'
}

export function createDefaultAgents(cwd = ''): Record<AgentId, AgentSnapshot> {
  return {
    claude: {
      id: 'claude',
      label: 'Claude',
      status: 'idle',
      integrationMode: 'simulated',
      activityLabel: 'Ready',
      cwd,
      available: true,
      pendingApprovalIds: []
    },
    codex: {
      id: 'codex',
      label: 'Codex',
      status: 'offline',
      integrationMode: 'unavailable',
      activityLabel: 'Not found',
      cwd,
      available: false,
      pendingApprovalIds: []
    },
    hermes: {
      id: 'hermes',
      label: 'Hermes',
      status: 'idle',
      integrationMode: 'simulated',
      activityLabel: 'Ready',
      cwd,
      available: true,
      pendingApprovalIds: []
    }
  }
}
