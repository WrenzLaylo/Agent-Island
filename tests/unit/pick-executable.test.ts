import { describe, expect, it } from 'vitest'
import { pickExecutable } from '../../src/main/agents/discover'

/**
 * The real `where codex` output from the machine that reported the bug. npm
 * installs an extensionless shell script beside its .cmd, and PATH put the
 * whole npm directory ahead of the real installer.
 */
const REAL_WHERE_OUTPUT = [
  'C:\\nvm4w\\nodejs\\codex',
  'C:\\nvm4w\\nodejs\\codex.cmd',
  'C:\\Users\\OASIS\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'
]

describe('pickExecutable on Windows', () => {
  it('does not pick the extensionless shim that caused error 193', () => {
    // Taking matches[0] is exactly what produced
    // "Could not start codex: Cannot create process, error code: 193".
    expect(pickExecutable(REAL_WHERE_OUTPUT, true)).not.toBe('C:\\nvm4w\\nodejs\\codex')
  })

  it('prefers the .exe over both the .cmd and the shim', () => {
    expect(pickExecutable(REAL_WHERE_OUTPUT, true)).toBe(
      'C:\\Users\\OASIS\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'
    )
  })

  it('falls back to .cmd when no .exe is present', () => {
    expect(pickExecutable(['C:\\bin\\codex', 'C:\\bin\\codex.cmd'], true)).toBe('C:\\bin\\codex.cmd')
  })

  it('keeps PATH order between entries of equal rank', () => {
    // Two .exe files: the one found first on PATH must still win.
    expect(pickExecutable(['C:\\a\\x.exe', 'C:\\b\\x.exe'], true)).toBe('C:\\a\\x.exe')
  })

  it('still returns an extensionless match when it is the only one', () => {
    // Ranked last, not discarded — reporting the agent as missing would be a
    // worse answer than returning something that might be a real PE image.
    expect(pickExecutable(['C:\\bin\\codex'], true)).toBe('C:\\bin\\codex')
  })

  it('ranks an unknown extension above an extensionless file', () => {
    expect(pickExecutable(['C:\\bin\\codex', 'C:\\bin\\codex.ps1'], true)).toBe('C:\\bin\\codex.ps1')
  })

  it('is not confused by a dot in a directory name', () => {
    // The extension check must look after the last separator, not the last dot.
    expect(pickExecutable(['C:\\my.tools\\codex', 'C:\\my.tools\\codex.exe'], true)).toBe(
      'C:\\my.tools\\codex.exe'
    )
  })

  it('returns undefined for no matches', () => {
    expect(pickExecutable([], true)).toBeUndefined()
  })
})

describe('pickExecutable elsewhere', () => {
  it('keeps the first match on POSIX, where extensions carry no meaning', () => {
    // An extensionless file is the norm on POSIX; reordering would be wrong.
    expect(pickExecutable(['/usr/local/bin/codex', '/usr/bin/codex'], false)).toBe(
      '/usr/local/bin/codex'
    )
  })
})
