import { describe, expect, it } from 'vitest'
import { detectChoice } from '../../src/main/agents/codex-approval'
import type { ApprovalDecision } from '../../src/shared/contracts'

/**
 * Every approval label Codex 0.146.1 can print, taken from its own source
 * rather than from a capture:
 *
 *   codex-rs/tui/src/bottom_pane/approval_overlay.rs
 *
 * A capture only shows the panels that happened to appear while someone was
 * watching. This is the complete set the renderer can produce, so a label we
 * classify wrongly — or not at all — shows up here instead of in the user's
 * terminal.
 *
 * `null` means deliberately unclassified: the row still renders verbatim and
 * is answered by its own digit, it simply carries no permission semantics.
 */
const LABELS: Array<[string, ApprovalDecision | null]> = [
  ['Yes, proceed', 'once'],
  ['Yes, just this once', 'once'],
  ['Yes, grant these permissions for this turn', 'once'],
  ['Yes, grant for this turn with strict auto review', 'once'],
  ['Yes, provide the requested info', 'once'],

  ['Yes, and allow these permissions for this session', 'session'],
  ['Yes, and allow this host for this conversation', 'session'],
  ['Yes, grant these permissions for this session', 'session'],
  ["Yes, and don't ask again for this command in this session", 'session'],
  // Patch approvals map this to acceptForSession, not to a permanent grant.
  ["Yes, and don't ask again for these files", 'session'],

  ['Yes, and allow this host in the future', 'always'],
  ["Yes, and don't ask again for commands that start with `npm test`", 'always'],

  ['No, continue without running it', 'deny'],
  ['No, continue without permissions', 'deny'],
  ['No, but continue without it', 'deny'],
  ['No, and block this host in the future', 'deny'],

  /*
   * Codex's cancel action, not a refusal: it aborts the whole turn. This is
   * the one that used to be classified as a deny, which is how answering
   * "No" in the island killed the turn instead of refusing one command.
   */
  ['No, and tell Codex what to do differently', null]
]

describe('codex approval labels', () => {
  for (const [label, expected] of LABELS) {
    it(`classifies "${label}" as ${expected ?? 'unclassified'}`, () => {
      expect(detectChoice(label)).toBe(expected)
    })
  }

  it('never promotes a session-scoped grant to a permanent one', () => {
    // The ordering hazard: the persistent "ask again" pattern would otherwise
    // swallow the session-scoped label and promise a grant Codex never gave.
    for (const [label, expected] of LABELS) {
      if (expected === 'session') expect(detectChoice(label)).not.toBe('always')
    }
  })

  it('classifies the curly and straight apostrophe identically', () => {
    // The source writes a straight quote; terminals and docs often show the
    // typographic one. Matching only one of them silently drops the row.
    expect(detectChoice("Yes, and don't ask again for these files")).toBe(
      detectChoice('Yes, and don’t ask again for these files')
    )
    expect(detectChoice("Yes, and don't ask again for commands that start with `x`")).toBe('always')
    expect(detectChoice('Yes, and don’t ask again for commands that start with `x`')).toBe('always')
  })
})
