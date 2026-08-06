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
})
