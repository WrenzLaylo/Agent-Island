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

describe('conversational permission questions', () => {
  /**
   * Captured from a real terminal: Claude asked before acting, rather than
   * being stopped by a tool permission. The island showed only a handoff card
   * -- "Claude needs input, continue in terminal" -- for a question whose five
   * options were right there and perfectly answerable.
   */
  const ASKED = [
    'Permission',
    '',
    'May I create the file `C:/Users/OASIS/Downloads/testing.txt`, and then delete it afterwards?',
    '',
    '❯ 1. Yes, create then delete',
    '  2. Create but keep it',
    '  3. No, don’t create it',
    '  4. Type something.',
    '  5. Chat about this',
    ''
  ].join(NL)

  it('detects it', () => {
    expect(detectClaudeApprovalPanel(ASKED)).not.toBeNull()
  })

  it('keeps all five options verbatim', () => {
    const detection = detectClaudeApprovalPanel(ASKED)
    expect(detection?.options.map((option) => option.index)).toEqual([1, 2, 3, 4, 5])
    expect(detection?.options[0].label).toBe('Yes, create then delete')
    expect(detection?.options[4].label).toBe('Chat about this')
  })

  it('is a question, not a permission grant', () => {
    // Three of the five rows are neither yes nor no; approve/deny language
    // would misdescribe what is being chosen.
    expect(detectClaudeApprovalPanel(ASKED)?.isPermission).toBe(false)
  })

  it('still ignores the same shape in prose', () => {
    const prose = ['May I suggest a few options?', '  1. Postgres', '  2. SQLite', ''].join(NL)
    expect(detectClaudeApprovalPanel(prose)).toBeNull()
  })
})

describe('the status line is not the request', () => {
  /**
   * Captured live: the card for a one-file permission question showed five
   * lines of "Computing… (8s . 188225 tokens)" where the question should have
   * been. Claude repaints that spinner several times a second directly above
   * the panel, and it was being collected as the request itself.
   */
  const WITH_SPINNER = [
    'Computing… (8s · ↓ 188225 tokens)',
    'Computing… (8s · ↓ 250 tokens)',
    'Computing… (9s · ↓ 36388413 tokens)',
    'May I create the file test.txt, then delete it right after?',
    '❯ 1. Yes, go ahead',
    '  2. Create but keep it',
    '  3. No, cancel',
    ''
  ].join(NL)

  it('keeps the spinner out of the card', () => {
    const detection = detectClaudeApprovalPanel(WITH_SPINNER)
    expect(detection).not.toBeNull()
    expect(detection?.command).not.toContain('Computing')
    expect(detection?.command).not.toContain('tokens')
  })

  it('falls back to the question when nothing else survives', () => {
    // `??` would not have: an empty string is not nullish, so filtering every
    // line away produced a card with no command on it.
    const detection = detectClaudeApprovalPanel(WITH_SPINNER)
    expect(detection?.command).toContain('May I create the file test.txt')
  })
})
