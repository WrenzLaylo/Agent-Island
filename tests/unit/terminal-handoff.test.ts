import { describe, expect, it } from 'vitest'
import { canSelectTab, handoffCaveat, handoffHeadline } from '../../src/shared/terminal-handoff'

describe('what a handoff card is headed with', () => {
  it('uses the prompt’s own words when it has any', () => {
    // A mirrored permission carries the agent's sentence. Replacing it with
    // "Claude needs input" threw away the only part naming what is being asked.
    expect(handoffHeadline('Claude needs your permission to use Bash', 'Claude')).toBe(
      'Claude needs your permission to use Bash'
    )
  })

  it('keeps the per-kind sentences the terminal detector already writes', () => {
    for (const title of ['Claude has a plan ready', 'Claude needs authentication']) {
      expect(handoffHeadline(title, 'Claude')).toBe(title)
    }
  })

  it('falls back only when there is genuinely no title', () => {
    expect(handoffHeadline(undefined, 'Codex')).toBe('Codex needs input')
    expect(handoffHeadline('', 'Codex')).toBe('Codex needs input')
    expect(handoffHeadline('   ', 'Codex')).toBe('Codex needs input')
  })
})

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

  it('says nothing about tabs when no window is raised at all', () => {
    /*
     * Two different things report themselves as `vscode`. An integrated
     * terminal resolves an hwnd through process ancestry, so the window comes
     * forward and only the tab is in doubt. A session hosted by the VS Code
     * extension's hooks has no window, and there the note rendered directly
     * beneath "does not expose a window Agent Island can raise" — promising in
     * one sentence what the line above had just ruled out. Seen on screen.
     */
    expect(handoffCaveat('vscode', 'Claude Code (no terminal)', false)).toBeNull()
  })

  it('still warns when the window can be raised', () => {
    expect(handoffCaveat('vscode', 'VS Code terminal', true)).toContain(
      'cannot select the terminal tab'
    )
  })
})
