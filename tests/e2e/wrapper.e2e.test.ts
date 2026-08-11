/**
 * End-to-end coverage for the wrapper.
 *
 * The rest of the suite tests pure functions, which is why every wrapper bug
 * this project has shipped got through: the tests encoded the same assumption
 * as the code, so both agreed with each other and disagreed with the terminal.
 * These tests run the built wrapper for real — node-pty, the output scan, the
 * registry writes, the decision poll and the keystroke send — against an agent
 * that reports exactly what it was sent.
 *
 * Each test drives one full round trip:
 *   fake agent prints a panel  ->  a prompt file appears
 *   a decision file is written ->  the fake agent receives specific bytes
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { WrapperRun } from './harness'

/*
 * Each case spawns a real wrapper, which spends about eight seconds resolving
 * its host window through PowerShell before the agent starts. Set here rather
 * than as a CLI flag so `npm test` runs these without special arguments.
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 })

const FIXTURES = resolve(__dirname, '..', 'fixtures', 'agent-output')
const NL = String.fromCharCode(10)
const ESC = String.fromCharCode(27)

/** Verbatim from CODEX_APPROVAL_UI_0.146.1.md. */
const CODEX_PANEL = [
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

const CLAUDE_PANEL = [
  'Bash command',
  '',
  '  git push origin main',
  '',
  'Do you want to proceed?',
  '\u276f 1. Yes',
  '  2. Yes, and don\u2019t ask again for git push commands in C:\\repo',
  '  3. No, and tell Claude what to do differently (esc)',
  ''
].join(NL)

let run: WrapperRun | null = null

afterEach(async () => {
  await run?.dispose()
  run = null
})

/** The wrapper only sends a digit it saw the agent print, so this must hold. */
function optionIndexes(options: Array<{ index: number }> | undefined): number[] {
  return (options ?? []).map((option) => option.index)
}

describe('wrapper end to end', () => {
  it('publishes a session the island can find', async () => {
    run = new WrapperRun('hermes')
    run.start([{ type: 'sleep', ms: 20_000 }])

    const sessions = await run.waitFor('a session file', () => run!.sessions())
    expect(sessions).toHaveLength(1)
    expect(sessions[0].agentId).toBe('hermes')
    expect(sessions[0].pid).toBeGreaterThan(0)
  })

  it('turns a real Hermes panel into a prompt with verbatim options', async () => {
    run = new WrapperRun('hermes')
    run.start([
      { type: 'sleep', ms: 400 },
      { type: 'emit', fixture: join(FIXTURES, 'hermes-dangerous-command.txt') },
      { type: 'waitForInput', timeoutMs: 30_000 }
    ])

    const prompts = await run.waitFor('a prompt file', () => run!.prompts())
    const prompt = prompts[0]

    expect(prompt.kind).toBe('approval')
    expect(prompt.agentId).toBe('hermes')
    // The whole point of the verbatim work: the agent's own wording reaches
    // the island unaltered, including the scope of the permanent option.
    expect(optionIndexes(prompt.options)).toEqual([1, 2, 3, 4])
    expect(prompt.options?.map((option) => option.label)).toEqual([
      'Allow once',
      'Allow for this session',
      'Add to permanent allowlist',
      'Deny'
    ])
    expect(prompt.detail).toContain('rm -rf node_modules')
  })

  it('sends the digit of the option the island answered with', async () => {
    run = new WrapperRun('hermes')
    run.start([
      { type: 'sleep', ms: 400 },
      { type: 'emit', fixture: join(FIXTURES, 'hermes-dangerous-command.txt') },
      { type: 'waitForInput', timeoutMs: 30_000 }
    ])

    const prompt = (await run.waitFor('a prompt file', () => run!.prompts()))[0]
    run.decide({
      sessionId: prompt.sessionId,
      promptId: prompt.promptId,
      optionIndex: 4,
      decidedAt: Date.now()
    })

    const keys = await run.waitFor('a keystroke', () => {
      const text = run!.keystrokeText()
      return text.length > 0 ? text : null
    })
    expect(keys).toBe('4')
  })

  it('retires the prompt once it has been answered', async () => {
    run = new WrapperRun('hermes')
    run.start([
      { type: 'sleep', ms: 400 },
      { type: 'emit', fixture: join(FIXTURES, 'hermes-dangerous-command.txt') },
      { type: 'waitForInput', timeoutMs: 30_000 }
    ])

    const prompt = (await run.waitFor('a prompt file', () => run!.prompts()))[0]
    run.decide({
      sessionId: prompt.sessionId,
      promptId: prompt.promptId,
      optionIndex: 1,
      decidedAt: Date.now()
    })

    // A prompt left on disk after it was answered is what made the island show
    // a card for a panel that had already gone.
    await run.waitFor('the prompt to clear', () => (run!.prompts().length === 0 ? true : null))
    expect(run.prompts()).toHaveLength(0)
  })

  it('raises one prompt for a panel that arrives in fragments', async () => {
    // A ConPTY delivers a panel in whatever chunks it feels like. Scanning per
    // chunk raised a fresh approval for each partial draw, which is what the
    // debounce exists to prevent.
    const panel = [
      '\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e',
      '\u2502 \u26a0\ufe0f  Dangerous Command   \u2502',
      '\u2502                        \u2502',
      '\u2502 rm -rf build           \u2502',
      '\u2502                        \u2502',
      '\u2502 \u276f 1. Allow once         \u2502',
      '\u2502   2. Allow for this session \u2502',
      '\u2502   3. Add to permanent allowlist \u2502',
      '\u2502   4. Deny              \u2502',
      '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f',
      ''
    ].join(NL)
    const third = Math.ceil(panel.length / 3)

    run = new WrapperRun('hermes')
    run.start([
      { type: 'sleep', ms: 400 },
      { type: 'emit', text: panel.slice(0, third) },
      { type: 'sleep', ms: 30 },
      { type: 'emit', text: panel.slice(third, third * 2) },
      { type: 'sleep', ms: 30 },
      { type: 'emit', text: panel.slice(third * 2) },
      { type: 'waitForInput', timeoutMs: 30_000 }
    ])

    await run.waitFor('a prompt file', () => run!.prompts())
    // Settle past the debounce window before counting.
    await new Promise((r) => setTimeout(r, 1200))
    expect(run.prompts()).toHaveLength(1)
  })

  it('never sends Esc to Codex, which would abort the whole turn', async () => {
    // Esc -> Cancel -> ReviewDecision::Abort -> interrupt_task(). This is the
    // one keystroke that must never leave the wrapper for a refusal.
    run = new WrapperRun('codex')
    run.start([
      { type: 'sleep', ms: 400 },
      { type: 'emit', text: CODEX_PANEL + NL },
      { type: 'waitForInput', timeoutMs: 30_000 }
    ])

    const prompt = (await run.waitFor('a prompt file', () => run!.prompts()))[0]
    const denyish = prompt.options?.find((option) => /^No\b/i.test(option.label))
    expect(denyish, 'Codex refusal row should have been captured').toBeTruthy()

    run.decide({
      sessionId: prompt.sessionId,
      promptId: prompt.promptId,
      optionIndex: denyish!.index,
      decidedAt: Date.now()
    })

    const keys = await run.waitFor('a keystroke', () => {
      const text = run!.keystrokeText()
      return text.length > 0 ? text : null
    })
    expect(keys).not.toContain(ESC)
    expect(keys).toBe(String(denyish!.index))
  })

  it('keeps the Codex permanent-scope wording intact', async () => {
    run = new WrapperRun('codex')
    run.start([
      { type: 'sleep', ms: 400 },
      { type: 'emit', text: CODEX_PANEL + NL },
      { type: 'waitForInput', timeoutMs: 30_000 }
    ])

    const prompt = (await run.waitFor('a prompt file', () => run!.prompts()))[0]
    // Dropping the scope is what made "Allow permanently" unsafe to click.
    const permanent = prompt.options?.find((option) => /don\u2019t ask again/i.test(option.label))
    expect(permanent?.label).toContain('echo hello world')
  })

  it('captures every option Claude prints, not only the classified ones', async () => {
    run = new WrapperRun('claude')
    run.start([
      { type: 'sleep', ms: 400 },
      { type: 'emit', text: CLAUDE_PANEL },
      { type: 'waitForInput', timeoutMs: 30_000 }
    ])

    const prompt = (await run.waitFor('a prompt file', () => run!.prompts()))[0]
    expect(optionIndexes(prompt.options)).toEqual([1, 2, 3])
  })

  it('refuses a digit the agent never offered', async () => {
    run = new WrapperRun('hermes')
    run.start([
      { type: 'sleep', ms: 400 },
      { type: 'emit', fixture: join(FIXTURES, 'hermes-dangerous-command.txt') },
      { type: 'sleep', ms: 30_000 }
    ])

    const prompt = (await run.waitFor('a prompt file', () => run!.prompts()))[0]
    run.decide({
      sessionId: prompt.sessionId,
      promptId: prompt.promptId,
      optionIndex: 9,
      decidedAt: Date.now()
    })

    await new Promise((r) => setTimeout(r, 1500))
    expect(run.keystrokeText()).toBe('')
    // The card must stay up rather than silently dismissing.
    expect(run.prompts()).toHaveLength(1)
  })
})
