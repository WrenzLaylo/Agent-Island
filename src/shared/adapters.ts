import type { AgentId, IntegrationMode } from './contracts'

/**
 * Phase 3 adapter contract.
 * Approval parsing stays terminal-basic until Phase 4.
 */
export interface AgentAdapterDescriptor {
  id: AgentId
  label: string
  /** How the island integrates with this agent today. */
  integrationMode: IntegrationMode
  /** CLI argv after the executable path. Empty = default interactive entry. */
  defaultArgs: string[]
  /** Extra env vars merged into the PTY environment. */
  env: Record<string, string>
  /** Human-readable capability summary for diagnostics. */
  capabilities: {
    interactiveTerminal: boolean
    multiSession: boolean
    islandApprovals: boolean
  }
  notes: string
}

export const AGENT_ADAPTERS: Record<AgentId, AgentAdapterDescriptor> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    integrationMode: 'terminal-basic',
    defaultArgs: [],
    env: {
      // Avoid nested noisy wrappers when hosted inside Agent Island.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
    },
    capabilities: {
      interactiveTerminal: true,
      multiSession: true,
      islandApprovals: false
    },
    notes: 'Claude Code via ConPTY. Island approvals not wired (Phase 4).'
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    integrationMode: 'terminal-basic',
    defaultArgs: [],
    env: {},
    capabilities: {
      interactiveTerminal: true,
      multiSession: true,
      islandApprovals: false
    },
    notes: 'Codex CLI via ConPTY when executable is found. Approvals Phase 4.'
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes',
    integrationMode: 'terminal-basic',
    defaultArgs: [],
    env: {
      // Prefer TUI-friendly output when Hermes supports it.
      HERMES_NO_COLOR: '0'
    },
    capabilities: {
      interactiveTerminal: true,
      multiSession: true,
      islandApprovals: true
    },
    notes: 'Hermes Agent via ConPTY. Dangerous-command panel bridged to island Approve/Deny.'
  }
}

export function getAdapter(agentId: AgentId): AgentAdapterDescriptor {
  return AGENT_ADAPTERS[agentId]
}

export function describeAdapterMode(mode: IntegrationMode): string {
  switch (mode) {
    case 'structured':
      return 'Structured API'
    case 'terminal-known':
      return 'Known terminal prompts'
    case 'terminal-basic':
      return 'Terminal only'
    case 'unavailable':
      return 'Unavailable'
    case 'simulated':
      return 'Simulated'
    default:
      return mode
  }
}
