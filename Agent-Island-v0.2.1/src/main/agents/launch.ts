import type { AgentId } from '../../shared/contracts'
import { getAdapter } from '../../shared/adapters'
import type { DiscoveredAgent } from './discover'
import type { LaunchSpec } from './process-manager'

/**
 * Resolve how to launch an agent from discovery + adapter descriptor.
 * Pure function — safe to unit test without spawning.
 */
export function buildLaunchSpec(
  agent: DiscoveredAgent,
  cwd: string,
  overrides?: { args?: string[] }
): LaunchSpec | { error: string } {
  if (!agent.available || !agent.path) {
    return { error: agent.notes ?? `${agent.id} is unavailable` }
  }

  const adapter = getAdapter(agent.id)
  const executable = agent.path
  const lower = executable.toLowerCase()
  const needsShell = lower.endsWith('.cmd') || lower.endsWith('.bat')
  const args = overrides?.args ?? adapter.defaultArgs

  if (needsShell) {
    const quoted = `"${executable}"${args.length ? ' ' + args.map(quoteArg).join(' ') : ''}`
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', quoted],
      cwd
    }
  }

  return {
    command: executable,
    args: [...args],
    cwd
  }
}

export function adapterEnv(agentId: AgentId): Record<string, string> {
  return { ...getAdapter(agentId).env }
}

export function mergeDiscoveryWithAdapter(agent: DiscoveredAgent): DiscoveredAgent {
  const adapter = getAdapter(agent.id)
  if (!agent.available) {
    return {
      ...agent,
      integrationMode: 'unavailable',
      notes: agent.notes ?? adapter.notes
    }
  }
  return {
    ...agent,
    // Discovery may set terminal-basic; keep adapter authoritative for capability story.
    integrationMode: adapter.integrationMode,
    notes: adapter.notes
  }
}

function quoteArg(arg: string): string {
  if (/[\s"]/g.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`
  }
  return arg
}
