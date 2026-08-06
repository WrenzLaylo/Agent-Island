import { describe, expect, it } from 'vitest'
import { verbatimOptions } from '../../src/shared/approval-options'
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

/** The shape Claude actually prints for a command approval. */
const CLAUDE_CHOICES = [
  { decision: 'once' as const, index: 1, label: 'Yes' },
  { decision: 'always' as const, index: 2, label: 'Yes, and don' + APOS + 't ask again for: curl *' },
  { decision: 'deny' as const, index: 3, label: 'No' }
]

describe('verbatimOptions', () => {
  it('keeps the agent wording exactly, including the scope of a permanent grant', () => {
    const rows = verbatimOptions(makeRequest({ choiceOptions: CLAUDE_CHOICES }))
    expect(rows.map((row) => row.label)).toEqual([
      'Yes',
      'Yes, and don' + APOS + 't ask again for: curl *',
      'No'
    ])
  })

  it('orders by the agent numbering, not by decision severity', () => {
    // Deliberately supplied out of order: the terminal's numbering wins, so the
    // row the user presses is the row they would have pressed in the terminal.
    const rows = verbatimOptions(
      makeRequest({
        choiceOptions: [
          { decision: 'deny', index: 3, label: 'No' },
          { decision: 'once', index: 1, label: 'Yes' },
          { decision: 'always', index: 2, label: 'Yes, and always' }
        ]
      })
    )
    expect(rows.map((row) => row.index)).toEqual([1, 2, 3])
  })

  it('carries the digit that will actually be sent', () => {
    const rows = verbatimOptions(makeRequest({ choiceOptions: CLAUDE_CHOICES }))
    expect(rows.map((row) => ({ index: row.index, decision: row.decision }))).toEqual([
      { index: 1, decision: 'once' },
      { index: 2, decision: 'always' },
      { index: 3, decision: 'deny' }
    ])
  })

  it('drops options the request no longer offers', () => {
    // `choices` is the authority on what may still be answered; a label alone
    // must not resurrect a decision that was filtered out upstream.
    const rows = verbatimOptions(
      makeRequest({ choiceOptions: CLAUDE_CHOICES, choices: ['once', 'deny'] })
    )
    expect(rows.map((row) => row.decision)).toEqual(['once', 'deny'])
  })

  it('falls back to nothing when the agent captured no labels', () => {
    // The caller renders its own wording in this case; returning a partial or
    // invented list here would silently mix the two vocabularies.
    expect(verbatimOptions(makeRequest())).toEqual([])
    expect(verbatimOptions(makeRequest({ choiceOptions: [] }))).toEqual([])
  })

  it('keeps every captured option when the request lists no explicit choices', () => {
    const rows = verbatimOptions(makeRequest({ choiceOptions: CLAUDE_CHOICES, choices: undefined }))
    expect(rows).toHaveLength(3)
  })

  it('does not mutate the request', () => {
    const choiceOptions = [
      { decision: 'deny' as const, index: 3, label: 'No' },
      { decision: 'once' as const, index: 1, label: 'Yes' }
    ]
    verbatimOptions(makeRequest({ choiceOptions }))
    expect(choiceOptions.map((option) => option.index)).toEqual([3, 1])
  })
})
