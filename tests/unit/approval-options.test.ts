import { describe, expect, it } from 'vitest'
import { approvalRows, isDenyRow } from '../../src/shared/approval-options'
import type { ApprovalRequest } from '../../src/shared/contracts'

const APOS = String.fromCharCode(39)

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const now = 1_700_000_000_000
  return {
    id: 'req-1',
    agentId: 'claude',
    summary: 'Claude wants to run a command',
    detail: 'Bash(curl https://example.com)',
    cwd: 'C:/work/api-service',
    risk: 'elevated',
    createdAt: now,
    expiresAt: now + 60_000,
    processAlive: true,
    waitingForInput: true,
    answered: false,
    superseded: false,
    ...overrides
  }
}

/** A panel where every option happens to classify. */
const CLASSIFIED = {
  options: [
    { index: 1, label: 'Yes' },
    { index: 2, label: 'Yes, and don' + APOS + 't ask again for: curl *' },
    { index: 3, label: 'No' }
  ],
  choiceOptions: [
    { decision: 'once' as const, index: 1, label: 'Yes' },
    { decision: 'always' as const, index: 2, label: 'Yes, and don' + APOS + 't ask again for: curl *' },
    { decision: 'deny' as const, index: 3, label: 'No' }
  ]
}

/**
 * The case that motivated this: option 2 is a real, selectable answer that no
 * permission vocabulary describes. It used to vanish from the card entirely.
 */
const WITH_UNCLASSIFIABLE = {
  options: [
    { index: 1, label: 'Yes' },
    { index: 2, label: 'Yes, but let me edit the command first' },
    { index: 3, label: 'Yes, and don' + APOS + 't ask again for: npm *' },
    { index: 4, label: 'No' }
  ],
  choiceOptions: [
    { decision: 'once' as const, index: 1, label: 'Yes' },
    { decision: 'always' as const, index: 3, label: 'Yes, and don' + APOS + 't ask again for: npm *' },
    { decision: 'deny' as const, index: 4, label: 'No' }
  ]
}

describe('approvalRows', () => {
  it('keeps the agent wording exactly, including a permanent grant scope', () => {
    const rows = approvalRows(makeRequest(CLASSIFIED))
    expect(rows.map((row) => row.label)).toEqual([
      'Yes',
      'Yes, and don' + APOS + 't ask again for: curl *',
      'No'
    ])
  })

  it('renders an option the classifier does not recognise', () => {
    const rows = approvalRows(makeRequest(WITH_UNCLASSIFIABLE))
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row.label)).toContain('Yes, but let me edit the command first')
  })

  it('leaves an unrecognised option unclassified rather than guessing', () => {
    const rows = approvalRows(makeRequest(WITH_UNCLASSIFIABLE))
    const edit = rows.find((row) => row.index === 2)
    expect(edit?.decision).toBeNull()
  })

  it('still attaches classifications to the options that have them', () => {
    const rows = approvalRows(makeRequest(WITH_UNCLASSIFIABLE))
    expect(rows.map((row) => [row.index, row.decision])).toEqual([
      [1, 'once'],
      [2, null],
      [3, 'always'],
      [4, 'deny']
    ])
  })

  it('orders by the agent numbering, not by decision severity', () => {
    const rows = approvalRows(
      makeRequest({
        options: [
          { index: 3, label: 'No' },
          { index: 1, label: 'Yes' },
          { index: 2, label: 'Yes, and always' }
        ],
        choiceOptions: [
          { decision: 'deny', index: 3, label: 'No' },
          { decision: 'once', index: 1, label: 'Yes' },
          { decision: 'always', index: 2, label: 'Yes, and always' }
        ]
      })
    )
    expect(rows.map((row) => row.index)).toEqual([1, 2, 3])
  })

  it('falls back to nothing when the agent captured no options', () => {
    // The card renders its own wording in this case; a partial list here would
    // silently mix the two vocabularies.
    expect(approvalRows(makeRequest())).toEqual([])
    expect(approvalRows(makeRequest({ options: [] }))).toEqual([])
  })

  it('works with options but no classifications at all', () => {
    const rows = approvalRows(
      makeRequest({ options: [{ index: 1, label: 'Postgres' }, { index: 2, label: 'SQLite' }] })
    )
    expect(rows.map((row) => row.decision)).toEqual([null, null])
    expect(rows.map((row) => row.label)).toEqual(['Postgres', 'SQLite'])
  })

  it('does not mutate the request', () => {
    const options = [
      { index: 3, label: 'No' },
      { index: 1, label: 'Yes' }
    ]
    approvalRows(makeRequest({ options }))
    expect(options.map((option) => option.index)).toEqual([3, 1])
  })
})

describe('isDenyRow', () => {
  it('recognises the refusal', () => {
    expect(isDenyRow({ decision: 'deny' })).toBe(true)
  })

  it('treats an unclassified row as an approval, not a refusal', () => {
    // Denials stay clickable when a request is no longer safe to approve.
    // Assuming an unrecognised row is harmless would let it through that gate.
    expect(isDenyRow({ decision: null })).toBe(false)
  })

  it('does not treat an allow as a refusal', () => {
    expect(isDenyRow({ decision: 'once' })).toBe(false)
    expect(isDenyRow({ decision: 'always' })).toBe(false)
    expect(isDenyRow({ decision: 'session' })).toBe(false)
  })
})
