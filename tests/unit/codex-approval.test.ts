import { describe, expect, it } from 'vitest'
import { createApprovalTrackerState } from '../../src/main/agents/hermes-approval'
import {
  detectCodexApprovalPanel,
  resolveCodexResponseKeys,
  updateCodexApprovalTracker
} from '../../src/main/agents/codex-approval'

const COMMAND_PROMPT = `
• Running curl -L https://example.com/

  Would you like to run the following command?

  Reason: Network access is required.

  $ curl -L https://example.com/

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`curl -L\` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
`

const EDIT_PROMPT = `
  Would you like to make the following edits?

  src/app.ts (+2 -1)

    1 -old
    1 +new

› 1. Yes, proceed
  2. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
`

describe('detectCodexApprovalPanel', () => {
  it('detects command approval choices and shortcuts', () => {
    const hit = detectCodexApprovalPanel(COMMAND_PROMPT)
    expect(hit?.kind).toBe('codex-command')
    expect(hit?.command).toContain('curl -L')
    expect(hit?.responseKeys.once).toBe('y')
    expect(hit?.responseKeys.always).toBe('p')
    expect(hit?.responseKeys.deny).toBe('\u001b')
    expect(hit?.choices.map((choice) => choice.key)).toEqual(['once', 'always', 'deny'])
  })

  it('detects file-change approvals without inventing persistence', () => {
    const hit = detectCodexApprovalPanel(EDIT_PROMPT)
    expect(hit?.kind).toBe('codex-file-change')
    expect(hit?.choices.map((choice) => choice.key)).toEqual(['once', 'deny'])
    expect(hit?.responseKeys.once).toBe('\r')
  })

  it('does not treat old scrollback as a current prompt', () => {
    expect(detectCodexApprovalPanel(`${COMMAND_PROMPT}\n${'work continued '.repeat(40)}`)).toBeNull()
  })
})

describe('Codex approval tracker', () => {
  it('raises a real Codex request and resolves available choices', () => {
    const update = updateCodexApprovalTracker({
      state: createApprovalTrackerState(),
      chunkOrFullBuffer: COMMAND_PROMPT,
      cwd: 'C:/repo',
      processAlive: true,
      now: 10,
      makeId: () => 'codex-1'
    })
    expect(update.raised?.id).toBe('codex-1')
    expect(update.raised?.source).toBe('codex-terminal')
    expect(update.raised?.choices).toEqual(['once', 'always', 'deny'])
    expect(resolveCodexResponseKeys(update.state, 'once')).toEqual({ ok: true, keys: 'y' })
    expect(resolveCodexResponseKeys(update.state, 'session').ok).toBe(false)
  })
})
