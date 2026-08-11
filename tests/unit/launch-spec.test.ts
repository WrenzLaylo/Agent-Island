import { describe, expect, it } from 'vitest'
import { buildLaunchSpec } from '../../src/main/agents/launch'
import type { DiscoveredAgent } from '../../src/main/agents/discover'

function agent(path: string): DiscoveredAgent {
  return {
    id: 'hermes',
    label: 'Hermes',
    available: true,
    path,
    integrationMode: 'terminal-known'
  } as DiscoveredAgent
}

describe('launch spec quoting', () => {
  /*
   * Found by the end-to-end harness, not by reasoning about the code: a .cmd
   * agent never started at all. The spec builds `cmd /d /s /c "<path>"`, then
   * both spawners quoted the already-quoted argument again, producing
   * `"\"<path>\""` — cmd.exe answers "is not recognized as an internal or
   * external command". npm installs its global shims as .cmd, so this covered
   * the ordinary install of every agent.
   */
  it('marks a shell launch as pre-quoted so spawners do not escape it twice', () => {
    const spec = buildLaunchSpec(agent('C:\\tools\\hermes.cmd'), 'C:\\work')
    expect('error' in spec).toBe(false)
    if ('error' in spec) return

    expect(spec.verbatim).toBe(true)
    expect(spec.commandLine).toBe('/d /s /c "C:\\tools\\hermes.cmd"')
    // The command line must not contain an escaped quote.
    expect(spec.commandLine).not.toContain('\\"')
  })

  it('handles a .bat shim the same way', () => {
    const spec = buildLaunchSpec(agent('C:\\tools\\hermes.bat'), 'C:\\work')
    if ('error' in spec) throw new Error(spec.error)
    expect(spec.verbatim).toBe(true)
    expect(spec.commandLine).toContain('hermes.bat')
  })

  it('leaves a real executable to normal argument escaping', () => {
    // An .exe takes its arguments as an array; forcing verbatim here would
    // break any path containing a space.
    const spec = buildLaunchSpec(agent('C:\\Program Files\\hermes.exe'), 'C:\\work')
    if ('error' in spec) throw new Error(spec.error)
    expect(spec.verbatim).toBe(false)
    expect(spec.commandLine).toBeUndefined()
    expect(spec.command).toBe('C:\\Program Files\\hermes.exe')
  })

  it('keeps a quoted path intact when the shim lives under a space', () => {
    const spec = buildLaunchSpec(agent('C:\\Program Files\\hermes.cmd'), 'C:\\work')
    if ('error' in spec) throw new Error(spec.error)
    expect(spec.commandLine).toBe('/d /s /c "C:\\Program Files\\hermes.cmd"')
  })
})
