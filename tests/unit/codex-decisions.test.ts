import { describe, expect, it } from 'vitest'
import { detectCodexApprovalPanel } from '../../src/main/agents/codex-approval'

const NL = String.fromCharCode(10)

/** Verbatim from CODEX_APPROVAL_UI_0.146.1.md — no box borders, dotted rows. */
const COMMAND_PANEL = [
  '  Would you like to run the following command?',
  '',
  '  $ echo hello world',
  '',
  '\u203a 1. Yes, proceed (y)',
  '  2. Yes, and don\u2019t ask again for commands that start with `echo hello world` (p)',
  '  3. No, and tell Codex what to do differently (esc)',
  '',
  '  Press enter to confirm or esc to cancel'
].join(NL)

/** The session-scoped variant that must NOT read as a permanent grant. */
const SESSION_SCOPED = [
  '  Would you like to run the following command?',
  '',
  '  $ npm test',
  '',
  '\u203a 1. Yes, proceed (y)',
  '  2. Yes, and don\u2019t ask again for this command in this session (a)',
  '  3. No, and tell Codex what to do differently (esc)',
  '',
  '  Press enter to confirm or esc to cancel'
].join(NL)

describe('codex keystrokes', () => {
  it('never sends Esc, which aborts the whole turn', () => {
    // Esc -> Cancel -> ReviewDecision::Abort -> interrupt_task(). Sending it
    // for an ordinary Deny killed the turn rather than refusing one command.
    const detection = detectCodexApprovalPanel(COMMAND_PANEL)
    const sent = Object.values(detection?.responseKeys ?? {})
    expect(sent.length).toBeGreaterThan(0)
    for (const keys of sent) expect(keys).not.toContain(String.fromCharCode(27))
  })

  it('sends a bare digit with no trailing Enter', () => {
    // A digit submits immediately; a trailing CR arrives after the overlay has
    // closed and lands in the composer.
    const detection = detectCodexApprovalPanel(COMMAND_PANEL)
    for (const keys of Object.values(detection?.responseKeys ?? {})) {
      expect(keys).toMatch(/^[0-9]$/)
    }
  })

  it('sends the digit of the row Codex actually drew', () => {
    const detection = detectCodexApprovalPanel(COMMAND_PANEL)
    expect(detection?.responseKeys.once).toBe('1')
    expect(detection?.responseKeys.always).toBe('2')
  })
})

describe('codex decision meanings', () => {
  it('does not classify the cancel row as a deny', () => {
    // "No, and tell Codex what to do differently" IS Codex's cancel action.
    // Calling it Deny both mislabelled it and let it past the deny gate.
    const detection = detectCodexApprovalPanel(COMMAND_PANEL)
    expect(detection?.choices.some((c) => c.key === 'deny')).toBe(false)
  })

  it('reads a session-scoped grant as session, not permanent', () => {
    // "...in this session" previously matched the persistent pattern, so the
    // card promised a standing permission Codex never offered.
    const detection = detectCodexApprovalPanel(SESSION_SCOPED)
    const row = detection?.choices.find((c) => c.index === 2)
    expect(row?.key).toBe('session')
  })

  it('still reads the persistent prefix grant as permanent', () => {
    const detection = detectCodexApprovalPanel(COMMAND_PANEL)
    expect(detection?.choices.find((c) => c.index === 2)?.key).toBe('always')
  })
})
