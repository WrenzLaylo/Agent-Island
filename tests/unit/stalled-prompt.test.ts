import { describe, expect, it } from 'vitest'
import { detectStalledPrompt } from '../../src/shared/stalled-prompt'

const NL = String.fromCharCode(10)
const MARK = String.fromCharCode(0x276f)

describe('detectStalledPrompt', () => {
  it('flags a marked picker', () => {
    const out = ['Some question?', '', `${MARK} 1. First`, '  2. Second', '  3. Third'].join(NL)
    expect(detectStalledPrompt(out)?.optionCount).toBe(3)
  })

  it('ignores a numbered list in ordinary prose', () => {
    // The regression that matters. Agents end turns with lists constantly and
    // then go quiet, exactly like a prompt does — see cc2d440.
    const out = ['I made three changes:', '', '1. Debounced the scan', '2. Added the hook', '3. Fixed the clear'].join(NL)
    expect(detectStalledPrompt(out)).toBeNull()
  })

  it('ignores a single marked row, which is not a choice', () => {
    expect(detectStalledPrompt([`${MARK} 1. Only one`].join(NL))).toBeNull()
  })

  it('reads through box drawing', () => {
    const out = [
      '╭─────╮',
      `│ ${MARK} 1. Allow once      │`,
      '│   2. Deny            │',
      '╰─────╯'
    ].join(NL)
    expect(detectStalledPrompt(out)?.optionCount).toBe(2)
  })

  it('accepts bracketed rows too', () => {
    const out = [`${MARK} [1] Yes`, '  [2] No'].join(NL)
    expect(detectStalledPrompt(out)?.optionCount).toBe(2)
  })

  it('gives the same fingerprint when only the marker moves', () => {
    // A TUI repaints the marker as the selection moves; that is not a new
    // stall and must not be reported as one.
    const first = detectStalledPrompt([`${MARK} 1. Alpha`, '  2. Beta'].join(NL))
    const second = detectStalledPrompt(['  1. Alpha', `${MARK} 2. Beta`].join(NL))
    expect(first?.fingerprint).toBe(second?.fingerprint)
  })

  it('gives a different fingerprint for different options', () => {
    const a = detectStalledPrompt([`${MARK} 1. Alpha`, '  2. Beta'].join(NL))
    const b = detectStalledPrompt([`${MARK} 1. Gamma`, '  2. Delta'].join(NL))
    expect(a?.fingerprint).not.toBe(b?.fingerprint)
  })

  it('only looks at the tail, so an old picker in scrollback is ignored', () => {
    const old = [`${MARK} 1. Old`, '  2. Picker']
    const since = Array.from({ length: 20 }, (_, i) => `output line ${i}`)
    expect(detectStalledPrompt([...old, ...since].join(NL))).toBeNull()
  })

  it('returns the marked row as a preview', () => {
    const out = [`${MARK} 1. Allow once`, '  2. Deny'].join(NL)
    expect(detectStalledPrompt(out)?.preview).toBe('❯ 1. Allow once')
  })

  it('handles empty input', () => {
    expect(detectStalledPrompt('')).toBeNull()
  })
})

describe('markdown must not read as a picker', () => {
  it('ignores a blockquoted numbered list', () => {
    // "> 1. ..." is a markdown blockquote around an ordered list. Agents write
    // this constantly, and this detector has no title or wording to rule it
    // out afterwards, so the marker set excludes `>` entirely.
    const out = ['As you noted:', '', '> 1. Quoted item', '> 2. Another one'].join(NL)
    expect(detectStalledPrompt(out)).toBeNull()
  })

  it('ignores a bulleted numbered list', () => {
    const out = ['Steps:', '', '* 1. First', '* 2. Second'].join(NL)
    expect(detectStalledPrompt(out)).toBeNull()
  })

  it('still accepts the Codex marker', () => {
    const out = [`${String.fromCharCode(0x203a)} 1. Yes, proceed`, '  2. No'].join(NL)
    expect(detectStalledPrompt(out)?.optionCount).toBe(2)
  })
})
