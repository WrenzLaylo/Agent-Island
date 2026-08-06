import { describe, expect, it } from 'vitest'
import {
  createTerminalInputTrackerState,
  detectTerminalInputPrompt,
  dismissTerminalInput,
  updateTerminalInputTracker
} from '../../src/main/agents/terminal-input'

const NEWLINE = String.fromCharCode(10)

describe('terminal input handoff detection', () => {
  it('detects Claude plan mode choices', () => {
    const result = detectTerminalInputPrompt(`
Plan mode
Would you like to proceed?
  1. Yes, clear context and auto-accept edits
  2. Yes, auto-accept edits
  3. Yes, manually approve edits
  4. Type here to tell Claude what to change
Use arrow keys · Enter to select · Esc to cancel
`, 'claude')

    expect(result?.kind).toBe('plan')
    expect(result?.title).toContain('Claude')
  })

  it('detects Codex plan selections', () => {
    const result = detectTerminalInputPrompt(`
Ready to implement the plan.
How would you like Codex to proceed?
› 1. Implement the plan
  2. Keep planning
  3. Tell Codex what to change
Press enter to confirm or esc to cancel
`, 'codex')

    expect(result?.kind).toBe('plan')
    expect(result?.detail).toContain('Implement the plan')
  })

  it('does not duplicate known Codex permission prompts', () => {
    const result = detectTerminalInputPrompt(`
Would you like to run the following command?
$ npm install
1. Yes, proceed
2. No, and tell Codex what to do differently
Press enter to confirm or esc to cancel
`, 'codex')

    expect(result).toBeNull()
  })


  it('allows a newer plan prompt after an old approval remains in scrollback', () => {
    const result = detectTerminalInputPrompt(`
Would you like to run the following command?
$ npm install
1. Yes, proceed
2. No
Press enter to confirm or esc to cancel

Plan mode
Would you like to proceed with the implementation plan?
1. Implement now
2. Keep planning
Enter to select · Esc to cancel
`, 'codex')

    expect(result?.kind).toBe('plan')
    expect(result?.detail).toContain('Implement now')
  })

  it('ignores ordinary mentions of an implementation plan', () => {
    const result = detectTerminalInputPrompt(
      'I created an implementation plan in plan.md and saved it successfully.',
      'claude'
    )

    expect(result).toBeNull()
  })

  it('does not reopen the same prompt after terminal handoff', () => {
    const output = `
Plan mode
Would you like to proceed?
1. Implement
2. Revise
Enter to select · Esc to cancel
`
    const first = updateTerminalInputTracker({
      state: createTerminalInputTrackerState(),
      chunkOrFullBuffer: output,
      agentId: 'claude',
      cwd: 'C:/project',
      processAlive: true,
      now: 1,
      makeId: () => 'prompt-1'
    })

    const dismissed = dismissTerminalInput(first.state, 'prompt-1')
    const second = updateTerminalInputTracker({
      state: dismissed,
      chunkOrFullBuffer: output,
      agentId: 'claude',
      cwd: 'C:/project',
      processAlive: true,
      now: 2,
      makeId: () => 'prompt-2'
    })

    expect(second.raised).toBeUndefined()
  })

  it('ignores a finished reply that merely ends in a question', () => {
    // Agents end ordinary replies with questions constantly. Without a rendered
    // option list, a key-hint footer, or a request for typed input, there is
    // nothing on screen for the user to act on — announcing "needs input" here
    // just echoed the last line of a completed reply back at them.
    const prose = [
      'I have finished the refactor and all 56 tests pass.',
      '',
      'The remaining risk is the multi-monitor path, which I could not verify.',
      'Would you like me to proceed with the merge?'
    ].join(NEWLINE)

    expect(detectTerminalInputPrompt(prose, 'claude')).toBeNull()
  })

  it('still detects a real prompt that renders options and a footer', () => {
    const real = [
      'Do you want to proceed?',
      '  1. Yes',
      '  2. Yes, and do not ask again',
      '  3. No, and tell Claude what to do differently',
      '',
      'Press enter to confirm or esc to cancel'
    ].join(NEWLINE)

    const detected = detectTerminalInputPrompt(real, 'claude')
    expect(detected).not.toBeNull()
  })
})
