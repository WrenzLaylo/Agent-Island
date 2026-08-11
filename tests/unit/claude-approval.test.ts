import { describe, expect, it } from 'vitest'
import {
  createApprovalTrackerState,
  detectClaudeApprovalPanel,
  resolveClaudeResponseKeys,
  updateClaudeApprovalTracker
} from '../../src/main/agents/claude-approval'

const NL = String.fromCharCode(10)
const APOS = String.fromCharCode(39)

function panel(lines: string[]): string {
  return lines.join(NL)
}

const BASH_APPROVAL = panel([
  'Bash command',
  '',
  '  npm run build',
  '  Build the project',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. Yes, and don' + APOS + 't ask again for npm run build commands in this folder',
  '  3. No, and tell Claude what to do differently (esc)'
])

const EDIT_APPROVAL = panel([
  'Edit file',
  '',
  '  index.ts',
  '',
  'Do you want to make this edit to index.ts?',
  '❯ 1. Yes',
  '  2. Yes, allow all edits during this session (shift+tab)',
  '  3. No, and tell Claude what to do differently (esc)'
])

describe('claude approval detection', () => {
  it('detects a bash command approval and maps every choice', () => {
    const detected = detectClaudeApprovalPanel(BASH_APPROVAL)
    expect(detected).not.toBeNull()
    expect(detected?.kind).toBe('claude-command')
    expect(detected?.choices.map((choice) => choice.key)).toEqual(['once', 'always', 'deny'])
    // Answering is by digit, matching the panel's own numbering.
    expect(detected?.responseKeys).toEqual({ once: '1', always: '2', deny: '3' })
  })

  it('detects an edit approval and treats session scope as session, not always', () => {
    const detected = detectClaudeApprovalPanel(EDIT_APPROVAL)
    expect(detected).not.toBeNull()
    expect(detected?.kind).toBe('claude-file-change')
    expect(detected?.choices.map((choice) => choice.key)).toEqual(['once', 'session', 'deny'])
    expect(detected?.risk).toBe('elevated')
  })

  it('ignores a numbered list that is not a permission panel', () => {
    const prose = panel([
      'Here is the plan:',
      '  1. Yes',
      '  2. Refactor the parser',
      '  3. Ship it'
    ])
    expect(detectClaudeApprovalPanel(prose)).toBeNull()
  })

  it('ignores a question with no choices', () => {
    expect(detectClaudeApprovalPanel('Do you want to proceed?')).toBeNull()
  })

  it('only treats the newest panel as live', () => {
    const answered = panel([
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No, and tell Claude what to do differently',
      '',
      'Running…',
      '',
      'Do you want to make this edit to server.ts?',
      '❯ 1. Yes',
      '  2. Yes, allow all edits during this session',
      '  3. No, and tell Claude what to do differently'
    ])
    expect(detectClaudeApprovalPanel(answered)?.kind).toBe('claude-file-change')
  })

  it('raises once, then stays quiet while the same panel is on screen', () => {
    const first = updateClaudeApprovalTracker({
      state: createApprovalTrackerState(),
      chunkOrFullBuffer: BASH_APPROVAL,
      cwd: 'C:/project',
      processAlive: true,
      now: 1,
      makeId: () => 'claude-1'
    })
    expect(first.raised?.id).toBe('claude-1')
    expect(first.raised?.source).toBe('claude-terminal')
    expect(first.raised?.choices).toEqual(['once', 'always', 'deny'])

    const again = updateClaudeApprovalTracker({
      state: first.state,
      chunkOrFullBuffer: BASH_APPROVAL,
      cwd: 'C:/project',
      processAlive: true,
      now: 2,
      makeId: () => 'claude-2'
    })
    expect(again.raised).toBeUndefined()
  })

  it('clears the request once the panel leaves the screen', () => {
    const raised = updateClaudeApprovalTracker({
      state: createApprovalTrackerState(),
      chunkOrFullBuffer: BASH_APPROVAL,
      cwd: 'C:/project',
      processAlive: true,
      now: 1,
      makeId: () => 'claude-1'
    })
    const gone = updateClaudeApprovalTracker({
      state: raised.state,
      chunkOrFullBuffer: 'Running the build…',
      cwd: 'C:/project',
      processAlive: true,
      now: 2
    })
    expect(gone.cleared?.id).toBe('claude-1')
    expect(gone.state.pending).toBeNull()
  })

  it('refuses a decision the panel did not offer', () => {
    const raised = updateClaudeApprovalTracker({
      state: createApprovalTrackerState(),
      chunkOrFullBuffer: EDIT_APPROVAL,
      cwd: 'C:/project',
      processAlive: true,
      now: 1,
      makeId: () => 'claude-1'
    })
    // The edit panel offers session, not a permanent allowlist.
    expect(resolveClaudeResponseKeys(raised.state, 'always').ok).toBe(false)
    expect(resolveClaudeResponseKeys(raised.state, 'session')).toEqual({ ok: true, keys: '2' })
  })

  it("detects the real panel captured from Claude Code 2.1.223", () => {
    // Captured live, not reconstructed. Note the deny option is a bare "No",
    // and the TUI repeats the highlighted row on redraw.
    const captured = panel([
      "Bash command",
      "",
      "  curl -sS https://example.com -o /dev/null",
      "",
      "Do you want to proceed?",
      "1. Yes",
      "2. Yes, and don" + String.fromCharCode(8217) + "t ask again for: curl *",
      "3. No",
      "1. Yes"
    ])
    const detected = detectClaudeApprovalPanel(captured)
    expect(detected).not.toBeNull()
    expect(detected?.kind).toBe("claude-command")
    expect(detected?.choices.map((choice) => choice.key)).toEqual(["once", "always", "deny"])
    expect(detected?.responseKeys).toEqual({ once: "1", always: "2", deny: "3" })
  })

  it('keeps TUI chrome out of the command block', () => {
    // Reproduces what the pill actually showed: the key-hint row and the
    // spinner were captured as if they were part of the command.
    const withChrome = panel([
      'Esc to cancel · Tab to amend · ctrl+e to explain',
      'Bash(curl -sS https://example.com -o /dev/null)',
      '  Waiting…',
      '',
      'Do you want to proceed?',
      '1. Yes',
      '2. Yes, and don' + String.fromCharCode(8217) + 't ask again for: curl *',
      '3. No'
    ])
    const detected = detectClaudeApprovalPanel(withChrome)
    expect(detected).not.toBeNull()
    expect(detected?.command).toBe('Bash(curl -sS https://example.com -o /dev/null)')
  })

  it('does not ask again once the answered panel is still in the buffer', () => {
    // The exact reported failure: approve, and the pill immediately asks
    // again, forever. The panel text stays in the replay buffer after it is
    // answered, so the detector kept re-finding it.
    const raised = updateClaudeApprovalTracker({
      state: createApprovalTrackerState(),
      chunkOrFullBuffer: BASH_APPROVAL,
      cwd: 'C:/project',
      processAlive: true,
      now: 1,
      makeId: () => 'claude-1'
    })
    expect(raised.raised?.id).toBe('claude-1')

    // The wrapper answers and clears `pending`, keeping the fingerprint.
    const answered = {
      pending: null,
      lastFingerprint: raised.state.pending?.fingerprint ?? null,
      responseKeys: null
    }

    const again = updateClaudeApprovalTracker({
      state: answered,
      chunkOrFullBuffer: BASH_APPROVAL,
      cwd: 'C:/project',
      processAlive: true,
      now: 2,
      makeId: () => 'claude-2'
    })
    expect(again.raised).toBeUndefined()
  })

  it('treats a panel buried behind later output as gone', () => {
    const withResult = BASH_APPROVAL + NL + 'x'.repeat(1200)
    expect(detectClaudeApprovalPanel(withResult)).toBeNull()
  })

  it('allows the same command to be requested again later', () => {
    const answered = {
      pending: null,
      lastFingerprint: 'stale-fingerprint',
      responseKeys: null
    }
    // Panel gone: the remembered fingerprint is dropped...
    const quiet = updateClaudeApprovalTracker({
      state: answered,
      chunkOrFullBuffer: 'Ran it, exit code 0.',
      cwd: 'C:/project',
      processAlive: true,
      now: 3
    })
    expect(quiet.state.lastFingerprint).toBeNull()
    // ...so a fresh request for the same command still reaches the user.
    const fresh = updateClaudeApprovalTracker({
      state: quiet.state,
      chunkOrFullBuffer: BASH_APPROVAL,
      cwd: 'C:/project',
      processAlive: true,
      now: 4,
      makeId: () => 'claude-3'
    })
    expect(fresh.raised?.id).toBe('claude-3')
  })

  it('keeps one identity while the TUI repaints the panel', () => {
    // The cause of the reported loop. Claude repaints spinner frames and key
    // hints above the question several times a second. Fingerprinting the
    // whole body meant every repaint looked like a brand new request, so an
    // approved one was raised again and again.
    const frame = (spinner: string, hint: string) =>
      panel([
        hint,
        'Bash(curl -sS https://example.com -o /dev/null)',
        '  ' + spinner,
        '',
        'Do you want to proceed?',
        '1. Yes',
        '2. Yes, and don' + String.fromCharCode(8217) + 't ask again for: curl *',
        '3. No'
      ])

    const a = detectClaudeApprovalPanel(frame('Waiting…', 'Esc to cancel · Tab to amend'))
    const b = detectClaudeApprovalPanel(frame('Working…', 'Esc to cancel · ctrl+e to explain'))
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a?.fingerprint).toBe(b?.fingerprint)
  })

  it('still separates two different commands', () => {
    const forCommand = (cmd: string) =>
      panel([
        'Bash(' + cmd + ')',
        '',
        'Do you want to proceed?',
        '1. Yes',
        '2. Yes, and don' + String.fromCharCode(8217) + 't ask again for: curl *',
        '3. No'
      ])
    const one = detectClaudeApprovalPanel(forCommand('curl -sS https://example.com'))
    const two = detectClaudeApprovalPanel(forCommand('curl -sS https://evil.test'))
    expect(one?.fingerprint).not.toBe(two?.fingerprint)
  })
})

/**
 * Plan mode. Captured shape: the question matches the permission wording, but
 * none of the affirmative options are `Yes`, `Yes, and don't ask again` or a
 * session variant — so the four-decision vocabulary cannot express them.
 */
const PLAN_MODE = panel([
  'Ready to code?',
  '',
  '  Here is what I plan to do:',
  '  1. Add the adapter',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes, and auto-accept edits',
  '  2. Yes, and manually approve edits',
  '  3. No, keep planning'
])

const OPEN_QUESTION = panel([
  'Which database should I use?',
  '',
  'Do you want to proceed?',
  '❯ 1. Postgres',
  '  2. SQLite',
  '  3. Let me type something else'
])

describe('claude numbered questions that are not permission grants', () => {
  it('detects plan mode instead of discarding it', () => {
    const detection = detectClaudeApprovalPanel(PLAN_MODE)
    expect(detection).not.toBeNull()
  })

  it('marks plan mode as not a permission grant', () => {
    const detection = detectClaudeApprovalPanel(PLAN_MODE)
    expect(detection?.isPermission).toBe(false)
  })

  it('carries every option verbatim, in order, with its digit', () => {
    const detection = detectClaudeApprovalPanel(PLAN_MODE)
    expect(detection?.options).toEqual([
      { index: 1, label: 'Yes, and auto-accept edits' },
      { index: 2, label: 'Yes, and manually approve edits' },
      { index: 3, label: 'No, keep planning' }
    ])
  })

  it('does not relabel an auto-accept option as a permanent permission', () => {
    // The old vocabulary would have had to call this `always`, which is a
    // materially different promise from what Claude offered.
    const detection = detectClaudeApprovalPanel(PLAN_MODE)
    expect(detection?.responseKeys.always).toBeUndefined()
    expect(detection?.responseKeys.once).toBeUndefined()
  })

  it('titles a non-permission panel as a question', () => {
    expect(detectClaudeApprovalPanel(PLAN_MODE)?.title).toBe('Claude is asking')
  })

  it('handles options that share no vocabulary with permissions at all', () => {
    const detection = detectClaudeApprovalPanel(OPEN_QUESTION)
    expect(detection?.isPermission).toBe(false)
    expect(detection?.options.map((option) => option.label)).toEqual([
      'Postgres',
      'SQLite',
      'Let me type something else'
    ])
  })

  it('still marks a real permission prompt as one', () => {
    const detection = detectClaudeApprovalPanel(BASH_APPROVAL)
    expect(detection?.isPermission).toBe(true)
    expect(detection?.options).toHaveLength(3)
  })

  it('gives two different questions two different fingerprints', () => {
    const a = detectClaudeApprovalPanel(PLAN_MODE)
    const b = detectClaudeApprovalPanel(OPEN_QUESTION)
    expect(a?.fingerprint).not.toBe(b?.fingerprint)
  })

  it('ignores a numbered list that is not a question', () => {
    expect(
      detectClaudeApprovalPanel(panel(['Here are the steps:', '  1. First', '  2. Second']))
    ).toBeNull()
  })
})

describe('answering before the island has raised anything', () => {
  const PANEL = panel([
    'Bash command',
    '',
    '  npm run build',
    '',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. Yes, and don' + APOS + 't ask again for npm commands',
    '  3. No'
  ])

  it('raises normally when nothing was answered', () => {
    const update = updateClaudeApprovalTracker({
      state: createApprovalTrackerState(),
      chunkOrFullBuffer: PANEL,
      cwd: '/w',
      processAlive: true
    })
    expect(update.raised).toBeTruthy()
  })

  it('does not raise a panel whose fingerprint was already answered', () => {
    // The wrapper records the on-screen fingerprint when the user answers
    // inside the debounce window. Without it, the pending scan finds the panel
    // still in the replay buffer and raises a request already settled — the
    // "sometimes it persists" report.
    const fingerprint = detectClaudeApprovalPanel(PANEL)?.fingerprint ?? ''
    expect(fingerprint).not.toBe('')

    const update = updateClaudeApprovalTracker({
      state: { pending: null, lastFingerprint: fingerprint, responseKeys: null },
      chunkOrFullBuffer: PANEL,
      cwd: '/w',
      processAlive: true
    })
    expect(update.raised).toBeUndefined()
  })

  it('still raises a genuinely different panel afterwards', () => {
    // Suppression must be specific to what was answered, not a blanket mute.
    const answered = detectClaudeApprovalPanel(PANEL)?.fingerprint ?? ''
    const next = panel([
      'Bash command',
      '',
      '  rm -rf dist',
      '',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No'
    ])
    const update = updateClaudeApprovalTracker({
      state: { pending: null, lastFingerprint: answered, responseKeys: null },
      chunkOrFullBuffer: next,
      cwd: '/w',
      processAlive: true
    })
    expect(update.raised).toBeTruthy()
  })
})
