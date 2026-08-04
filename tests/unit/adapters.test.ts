import { describe, expect, it } from 'vitest'
import { getAdapter, describeAdapterMode } from '../../src/shared/adapters'
import { buildLaunchSpec, mergeDiscoveryWithAdapter } from '../../src/main/agents/launch'

describe('adapters', () => {
  it('declares multi-session terminal capability without island approvals for claude/codex', () => {
    for (const id of ['claude', 'codex'] as const) {
      const adapter = getAdapter(id)
      expect(adapter.capabilities.interactiveTerminal).toBe(true)
      expect(adapter.capabilities.multiSession).toBe(true)
      expect(adapter.capabilities.islandApprovals).toBe(false)
      expect(adapter.integrationMode).toBe('terminal-basic')
    }
  })

  it('enables island approvals for hermes in phase 4', () => {
    const adapter = getAdapter('hermes')
    expect(adapter.capabilities.islandApprovals).toBe(true)
  })

  it('describes modes for diagnostics', () => {
    expect(describeAdapterMode('terminal-basic')).toMatch(/terminal/i)
    expect(describeAdapterMode('unavailable')).toMatch(/unavailable/i)
  })
})

describe('buildLaunchSpec', () => {
  it('returns error for unavailable agent', () => {
    const result = buildLaunchSpec(
      {
        id: 'codex',
        label: 'Codex',
        available: false,
        integrationMode: 'unavailable',
        notes: 'missing'
      },
      'C:/tmp'
    )
    expect(result).toEqual({ error: 'missing' })
  })

  it('launches hermes exe directly', () => {
    const result = buildLaunchSpec(
      {
        id: 'hermes',
        label: 'Hermes',
        available: true,
        path: 'C:/tools/hermes.exe',
        integrationMode: 'terminal-basic'
      },
      'C:/work'
    )
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.command).toBe('C:/tools/hermes.exe')
    expect(result.args).toEqual([])
    expect(result.cwd).toBe('C:/work')
  })

  it('wraps cmd shims for windows', () => {
    const result = buildLaunchSpec(
      {
        id: 'codex',
        label: 'Codex',
        available: true,
        path: 'C:/Users/me/AppData/Roaming/npm/codex.cmd',
        integrationMode: 'terminal-basic'
      },
      'C:/proj'
    )
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.command.toLowerCase()).toContain('cmd')
    expect(result.args.join(' ')).toContain('codex.cmd')
  })

  it('merges adapter notes onto discovery results', () => {
    const merged = mergeDiscoveryWithAdapter({
      id: 'claude',
      label: 'Claude',
      available: true,
      path: 'C:/claude.exe',
      integrationMode: 'simulated'
    })
    expect(merged.integrationMode).toBe('terminal-basic')
    expect(merged.notes).toMatch(/Claude/i)
  })
})
