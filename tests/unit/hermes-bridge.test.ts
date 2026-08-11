import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The bundled plugin is the source of truth for what gets installed, so its
 * manifest has to stay parseable by the same one-line regex the installer
 * uses. A YAML parser is deliberately not a dependency for two fields.
 */
const PLUGIN_YAML = join(process.cwd(), 'plugins', 'agent-island-bridge', 'plugin.yaml')

function readVersion(raw: string): string | null {
  const match = /^\s*version:\s*(.+?)\s*$/m.exec(raw)
  return match?.[1] ?? null
}

describe('bundled Hermes bridge manifest', () => {
  it('declares a version the installer can read', () => {
    expect(readVersion(readFileSync(PLUGIN_YAML, 'utf8'))).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('declares the hooks the island relies on', () => {
    // on_session_start registers the session; pre_approval_request is the
    // structured channel itself. Losing either silently drops Hermes back to
    // terminal parsing, which is the failure this task exists to prevent.
    const raw = readFileSync(PLUGIN_YAML, 'utf8')
    expect(raw).toContain('on_session_start')
    expect(raw).toContain('pre_approval_request')
  })
})

describe('version comparison', () => {
  it('treats an older installed copy as not current', () => {
    expect(readVersion('version: 0.1.0') === readVersion('version: 0.2.0')).toBe(false)
  })

  it('treats a matching copy as current', () => {
    expect(readVersion('version: 0.2.0') === readVersion('version: 0.2.0')).toBe(true)
  })

  it('reads a version with surrounding whitespace', () => {
    expect(readVersion('  version:   1.2.3   ')).toBe('1.2.3')
  })

  it('returns null when there is no version line', () => {
    expect(readVersion('name: something\nhooks:\n  - a')).toBeNull()
  })

  it('does not match a version-like word elsewhere', () => {
    // "description: ... version 9" must not be mistaken for the field.
    expect(readVersion('description: bumps the version 9 thing')).toBeNull()
  })
})
