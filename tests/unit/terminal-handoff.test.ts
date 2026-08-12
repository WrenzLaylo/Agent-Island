import { describe, expect, it } from 'vitest'
import { canSelectTab, handoffCaveat } from '../../src/shared/terminal-handoff'

describe('what handoff can promise', () => {
  it('can select a tab only in Windows Terminal', () => {
    // The title-marker + UI Automation route works there and nowhere else.
    expect(canSelectTab('windows-terminal')).toBe(true)
    for (const kind of ['vscode', 'conhost', 'mintty', 'unknown'] as const) {
      expect(canSelectTab(kind)).toBe(false)
    }
  })

  it('warns that a VS Code terminal tab cannot be selected', () => {
    /*
     * The island resolves a VS Code session's window through process ancestry,
     * so hwnd is set and handoff *looks* like it works. It brings the window
     * forward and stops — leaving the user on whichever terminal was last
     * active, which with several open is usually the wrong one.
     */
    const note = handoffCaveat('vscode', 'VS Code terminal')
    expect(note).toContain('cannot select the terminal tab')
    expect(note).toContain('VS Code terminal')
  })

  it('says nothing when the window is the session', () => {
    // A conhost or mintty window *is* the terminal, so raising it lands
    // exactly where the user expects and a note would be noise.
    expect(handoffCaveat('conhost')).toBeNull()
    expect(handoffCaveat('mintty')).toBeNull()
  })

  it('says nothing when the tab can actually be selected', () => {
    expect(handoffCaveat('windows-terminal')).toBeNull()
  })

  it('says nothing for an unknown host rather than guessing', () => {
    // Claiming a limitation we have not established is its own kind of wrong.
    expect(handoffCaveat('unknown')).toBeNull()
    expect(handoffCaveat(undefined)).toBeNull()
  })

  it('falls back to a plain name when the label is missing', () => {
    expect(handoffCaveat('vscode')).toContain('VS Code')
  })
})
