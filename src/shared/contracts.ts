export type AgentId = 'claude' | 'codex' | 'hermes'

export type DockSide = 'left' | 'right'
export type PreferredDockSide = DockSide | 'none'

export interface IslandWindowLayout {
  docked: DockSide | null
  bounds: { x: number; y: number; width: number; height: number } | null
}

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

export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny'

export type TerminalInputKind = 'plan' | 'selection' | 'question' | 'authentication' | 'unsupported'

/**
 * A live terminal prompt that Agent Island deliberately does not try to answer.
 * The safe action is to hand control back to the managed terminal window.
 */
export interface TerminalInputPrompt {
  id: string
  agentId: AgentId
  kind: TerminalInputKind
  title: string
  detail?: string
  cwd: string
  createdAt: number
  expiresAt: number
  processAlive: boolean
  waitingForInput: boolean
  fingerprint: string
}

export type TransientKind =
  | 'approved'
  | 'denied'
  | 'expired'
  | 'cancelled'
  | 'error'
  | 'completed'

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
  /** Where this request came from. */
  source?:
    | 'demo'
    | 'hermes-bridge'
    | 'hermes-terminal'
    | 'claude-terminal'
    | 'codex-terminal'
  /** Stable hash of the detected prompt content for stale checks. */
  fingerprint?: string
  /** Decisions the source agent actually exposes for this request. */
  choices?: ApprovalDecision[]
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
  version?: string
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
  transientKind?: TransientKind
}

export interface IslandSettings {
  launchAtStartup: boolean
  alwaysOnTop: boolean
  autoExpandApprovals: boolean
  autoCollapseMs: number
  preferredDockSide: PreferredDockSide
  reducedMotion: boolean
  approvalSounds: boolean
  rememberLastAgent: boolean
  lastAgentId: AgentId
  glassIntensity: number
  quietIdle: boolean
  developerDiagnostics: boolean
  onboardingComplete: boolean
}

export const DEFAULT_ISLAND_SETTINGS: IslandSettings = {
  launchAtStartup: false,
  alwaysOnTop: true,
  autoExpandApprovals: true,
  autoCollapseMs: 900,
  preferredDockSide: 'none',
  reducedMotion: false,
  approvalSounds: true,
  rememberLastAgent: true,
  lastAgentId: 'hermes',
  glassIntensity: 0.74,
  quietIdle: true,
  developerDiagnostics: false,
  onboardingComplete: false
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
      status: 'offline',
      integrationMode: 'unavailable',
      activityLabel: 'Checking…',
      cwd,
      available: false,
      pendingApprovalIds: []
    },
    codex: {
      id: 'codex',
      label: 'Codex',
      status: 'offline',
      integrationMode: 'unavailable',
      activityLabel: 'Checking…',
      cwd,
      available: false,
      pendingApprovalIds: []
    },
    hermes: {
      id: 'hermes',
      label: 'Hermes',
      status: 'offline',
      integrationMode: 'unavailable',
      activityLabel: 'Checking…',
      cwd,
      available: false,
      pendingApprovalIds: []
    }
  }
}
