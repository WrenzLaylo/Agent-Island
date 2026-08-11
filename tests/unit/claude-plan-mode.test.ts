import { describe, expect, it } from 'vitest'
import { detectClaudeApprovalPanel } from '../../src/main/agents/claude-approval'

const NL = String.fromCharCode(10)

/**
 * Plan mode asks "Would you like to proceed?", not "Do you want to …?".
 * The detector anchored on the latter, so every plan approval was invisible to
 * the island — the panel sat in the terminal and the pill showed nothing.
 */
const PLAN_PANEL = [
  'Ready to code?',
  '',
  'Here is the plan:',
  '  1. Extract the spring',
  '  2. Add tests',
  '',
  'Would you like to proceed?',
  '❯ 1. Yes, and auto-accept edits',
  '  2. Yes, and manually approve edits',
  '  3. No, keep planning',
  ''
].join(NL)

describe('claude plan mode', () => {
  it('detects the plan prompt', () => {
    const detection = detectClaudeApprovalPanel(PLAN_PANEL)
    expect(detection).not.toBeNull()
    expect(detection?.options.map((option) => option.index)).toEqual([1, 2, 3])
  })

  it('keeps the options verbatim, including the scope of each yes', () => {
    // "auto-accept edits" and "manually approve edits" are different promises;
    // paraphrasing either to "Allow" would misstate what is being agreed to.
    const detection = detectClaudeApprovalPanel(PLAN_PANEL)
    expect(detection?.options.map((option) => option.label)).toEqual([
      'Yes, and auto-accept edits',
      'Yes, and manually approve edits',
      'No, keep planning'
    ])
  })

  it('does not present a plan as a permission grant', () => {
    // Two of the three rows are a yes. Approve/deny language would imply the
    // user is authorising a command rather than choosing how to proceed.
    const detection = detectClaudeApprovalPanel(PLAN_PANEL)
    expect(detection?.isPermission).toBe(false)
  })

  it('ignores a numbered list in ordinary prose', () => {
    /*
     * The reason the relaxed wording requires a caret. Claude writes exactly
     * this shape while explaining itself, and raising a card for it would
     * interrupt the user to answer something nobody asked.
     */
    const prose = [
      'I looked at three options.',
      '',
      'Would you like to see the tradeoffs?',
      '  1. Postgres is the safe default',
      '  2. SQLite keeps the deployment simple',
      ''
    ].join(NL)
    expect(detectClaudeApprovalPanel(prose)).toBeNull()
  })

  it('still ignores prose that merely ends in a question mark', () => {
    const prose = ['So which should we use?', '  1. Postgres', '  2. SQLite', ''].join(NL)
    expect(detectClaudeApprovalPanel(prose)).toBeNull()
  })

  it('leaves the original wording working exactly as before', () => {
    // The change is additive; a regression here would break every ordinary
    // command approval.
    const classic = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', ''].join(NL)
    const detection = detectClaudeApprovalPanel(classic)
    expect(detection).not.toBeNull()
    expect(detection?.isPermission).toBe(true)
  })

  it('accepts the classic wording with no caret at all', () => {
    // Some captures arrive with the caret stripped; requiring it universally
    // would have been a regression rather than a fix.
    const noCaret = ['Do you want to proceed?', '  1. Yes', '  2. No', ''].join(NL)
    expect(detectClaudeApprovalPanel(noCaret)).not.toBeNull()
  })
})
