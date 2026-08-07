import { describe, expect, it } from 'vitest'
import { detectTerminalInputPrompt } from '../../src/main/agents/terminal-input'

const NL = String.fromCharCode(10)

/**
 * The exact shape that produced a false "Claude needs input" card: an agent
 * discussing prompt wording in prose, with an unrelated numbered list rendered
 * further down the screen. Neither part is a prompt; together they used to
 * satisfy the detector, and the card's detail was a fragment of the sentence.
 */
const PROSE_THEN_UNRELATED_LIST = [
  'Still unverified',
  '',
  'These all need a real session, not staged files:',
  '',
  'Plan mode - the detector matches only "Do you want to...?". If Claude asks',
  '"Would you like to proceed?" the whole feature silently does nothing.',
  'Highest-risk item.',
  '',
  'Codex - installed but its adapter has never run live.',
  'Multi-monitor handoff - reasoned about, never tested.',
  '',
  'Here is the release checklist I mentioned:',
  '',
  '1. Tag the release',
  '2. Publish the notes',
  '3. Announce it'
].join(NL)

/** A genuine plan prompt: the question sits directly above its choices. */
const REAL_PLAN_PROMPT = [
  'Here is my implementation plan:',
  '  - Add the adapter',
  '  - Wire the tests',
  '',
  'Would you like to proceed?',
  '1. Yes, and auto-accept edits',
  '2. Yes, and manually approve edits',
  '3. No, keep planning'
].join(NL)

describe('terminal input detection on ordinary prose', () => {
  it('does not raise on prose that merely quotes prompt wording', () => {
    const detection = detectTerminalInputPrompt(PROSE_THEN_UNRELATED_LIST, 'claude')
    expect(detection).toBeNull()
  })

  it('still raises when the question sits directly above its choices', () => {
    const detection = detectTerminalInputPrompt(REAL_PLAN_PROMPT, 'claude')
    expect(detection).not.toBeNull()
  })

  it('does not raise on a numbered list in an ordinary reply', () => {
    const reply = [
      'I made three changes:',
      '',
      '1. Debounced the scan',
      '2. Added the stdin hook',
      '3. Fixed the silent clear'
    ].join(NL)
    expect(detectTerminalInputPrompt(reply, 'claude')).toBeNull()
  })

  it('does not raise when the plan phrase is far above an unrelated list', () => {
    // Same two ingredients, separated by more than a block. Distance is the
    // only thing distinguishing this from the real prompt above.
    const spaced = [
      'Would you like to proceed? — that is the phrasing we do not match yet.',
      ...Array.from({ length: 10 }, (_, i) => `filler line ${i + 1}`),
      '1. Alpha',
      '2. Beta'
    ].join(NL)
    expect(detectTerminalInputPrompt(spaced, 'claude')).toBeNull()
  })
})
