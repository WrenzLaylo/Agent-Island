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

/**
 * A numbered option exactly as the agent printed it.
 *
 * Plan mode and ordinary questions offer options that no fixed vocabulary can
 * express — "Yes, and auto-accept edits", "No, keep planning", "Postgres".
 * They are shown verbatim and answered by their own digit, so the island never
 * has to claim an option means something it does not.
 */
export interface PromptOption {
  index: number
  label: string
  /**
   * Exact keystrokes that select this option.
   *
   * Not derivable from the index: Claude takes a bare digit, Hermes wants the
   * digit followed by Enter, and Codex uses `y`/`p`/Esc shortcuts for some
   * rows. Sending a bare digit to Codex selects nothing at all, so the agent
   * that parsed the panel is the only thing that can say how to answer it.
   */
  keys?: string
}

/**
 * A classified decision together with the wording the agent actually printed.
 *
 * The island used to render its own phrases for these — "Allow permanently"
 * in place of "Yes, and don't ask again for: curl *". That dropped the one
 * thing that made the choice safe to make: its scope. The agent's own text is
 * authoritative; the classification only decides which keystroke to send and
 * which extra confirmation to require.
 */
export interface DecisionOption {
  decision: ApprovalDecision
  index: number
  label: string
}

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
  /** Registry session that raised this. */
  sessionId?: string
  /** Human label for the hosting terminal, e.g. "Windows Terminal". */
  terminalLabel?: string
  /** False when the host exposes no raisable window (VS Code panels). */
  canRaiseWindow?: boolean
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
  /** Registry session that raised this, when it came from an `island` wrapper. */
  sessionId?: string
  /** Numbered options verbatim, when the agent offered a list. */
  options?: PromptOption[]
  /** Classified decisions paired with the agent's own wording. */
  choiceOptions?: DecisionOption[]
  /**
   * False when the panel is a question rather than a permission grant. Such a
   * request must not be rendered with approve/deny language.
   */
  isPermission?: boolean
  /**
   * Which terminal asked, e.g. "Windows Terminal". Two sessions of the same
   * agent are otherwise indistinguishable on the card, and approving the wrong
   * one is not a recoverable mistake.
   */
  terminalLabel?: string
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
  /** Move the agent's terminal to the island's display on handoff. */
  moveTerminalToIsland: boolean
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
  onboardingComplete: false,
  moveTerminalToIsland: true
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
