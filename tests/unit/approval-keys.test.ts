import { describe, expect, it } from 'vitest'
import { rowForKey, rowKey } from '../../src/shared/approval-keys'
import { toggleEvent } from '../../src/shared/island-machine'

const decisionRows = [
  { index: null, decision: 'once' },
  { index: null, decision: 'deny' }
]
const numberedRows = [
  { index: 1, decision: 'once' },
  { index: 3, decision: 'deny' }
]

describe('approval key mapping', () => {
  it('numbers decision rows by position', () => {
    expect(rowKey(decisionRows[1], 1)).toBe(2)
    expect(rowForKey(decisionRows, { key: '2' })).toBe(decisionRows[1])
  })

  it('uses the digit the agent printed, because that is what gets sent', () => {
    expect(rowKey(numberedRows[1], 1)).toBe(3)
    expect(rowForKey(numberedRows, { key: '3' })).toBe(numberedRows[1])
    expect(rowForKey(numberedRows, { key: '2' })).toBeNull()
  })

  it('ignores a held key, so one press can never answer twice', () => {
    expect(rowForKey(decisionRows, { key: '1', repeat: true })).toBeNull()
  })

  it.each(['ctrlKey', 'altKey', 'metaKey'])('ignores digits pressed with %s', (modifier) => {
    expect(rowForKey(decisionRows, { key: '1', [modifier]: true })).toBeNull()
  })

  it('ignores everything that is not a digit from 1 to 9', () => {
    for (const key of ['0', 'a', 'Enter', ' ', 'Escape', '10']) {
      expect(rowForKey(decisionRows, { key })).toBeNull()
    }
  })
})

describe('the island shortcut', () => {
  it('opens a collapsed island', () => {
    expect(toggleEvent('collapsed')).toBe('CLICK_PILL')
  })

  it('collapses an open one', () => {
    expect(toggleEvent('peek')).toBe('COLLAPSE')
  })

  it('leaves an open approval up, so the shortcut can focus it for the keyboard', () => {
    expect(toggleEvent('approval')).toBeNull()
  })
})
