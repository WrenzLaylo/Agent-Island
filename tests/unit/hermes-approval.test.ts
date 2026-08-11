import { describe, expect, it } from 'vitest'
import { stripAnsi } from '../../src/shared/ansi'
import {
  detectHermesApprovalPanel,
  updateHermesApprovalTracker,
  resolveHermesResponseKeys,
  createApprovalTrackerState,
  classifyCommandRisk
} from '../../src/main/agents/hermes-approval'

/*
 * Hermes Agent v0.19.1, as its own prompt formatter renders it. Dotted
 * choices, no footer, and the description sits BELOW the options.
 *
 * The previous fixtures used bracketed `[1]` rows plus a `Type 1/2/3 or use`
 * footer, which is Hermes' slash-command confirmation UI, not this panel. The
 * detector was written to match those fixtures, so it agreed with the tests
 * and disagreed with every real Hermes session.
 */
const REAL_PANEL = `
some agent output...
╭───────────────╮
│ ⚠️  Dangerous Command      │
│                                │
│ rm -rf node_modules            │
│                                │
│ ❯ 1. Allow once               │
│   2. Allow for this session    │
│   3. Add to permanent allowlist│
│   4. Deny                      │
│                                │
│ recursive delete               │
╰───────────────╯
`

const SMART_DENY_PANEL = `
╭───────────────╮
│ ⚠️  Dangerous Command      │
│                                │
│ git push --force origin main   │
│                                │
│ ❯ 1. Allow once               │
│   2. Deny                      │
│                                │
│ destructive git history rewrite│
╰───────────────╯
`

/* A slash-command confirmation: bracketed rows and a footer. Must NOT be
   mistaken for a dangerous-command approval. */
const SLASH_CONFIRMATION = `
╭───────────────╮
│ Run this skill?                │
│                                │
│ ❯ [1] Yes — run it            │
│   [2] No — cancel              │
│                                │
│ Type 1/2/3 or use ↑/↓ then Enter. │
╰───────────────╯
`

describe('stripAnsi', () => {
  it('removes csi color codes', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red')
  })
})

describe('detectHermesApprovalPanel', () => {
  it('detects a real Hermes dangerous-command panel', () => {
    const hit = detectHermesApprovalPanel(REAL_PANEL)
    expect(hit).not.toBeNull()
    expect(hit?.command).toContain('rm -rf node_modules')
    expect(hit?.responseKeys.once).toBe('1')
    expect(hit?.responseKeys.session).toBe('2')
    expect(hit?.responseKeys.always).toBe('3')
    expect(hit?.responseKeys.deny).toBe('4')
    expect(hit?.risk).toBe('high')
  })

  it('detects smart-deny two-choice panels', () => {
    const hit = detectHermesApprovalPanel(SMART_DENY_PANEL)
    expect(hit).not.toBeNull()
    expect(hit?.responseKeys.once).toBe('1')
    expect(hit?.responseKeys.deny).toBe('2')
  })

  it('ignores free text that only mentions approve', () => {
    expect(
      detectHermesApprovalPanel('Please approve this PR and merge when ready')
    ).toBeNull()
  })

  it('ignores incomplete panels missing choices', () => {
    expect(
      detectHermesApprovalPanel('Dangerous Command\nType 1/2/3 or use arrows')
    ).toBeNull()
  })

  it('ignores panels without Deny option', () => {
    const panel = `
Dangerous Command
[1] Allow once
Type 1/2/3 or use ↑/↓ then Enter. ESC/Ctrl+C cancels.
`
    expect(detectHermesApprovalPanel(panel)).toBeNull()
  })

  it('still works with ansi noise', () => {
    const noisy = REAL_PANEL.replace(
      'Dangerous Command',
      '\u001b[33mDangerous Command\u001b[0m'
    )
    expect(detectHermesApprovalPanel(noisy)?.command).toContain('rm -rf')
  })
})

describe('updateHermesApprovalTracker', () => {
  it('raises once per fingerprint and clears when panel leaves', () => {
    let state = createApprovalTrackerState()
    const first = updateHermesApprovalTracker({
      state,
      chunkOrFullBuffer: REAL_PANEL,
      agentId: 'hermes',
      cwd: 'C:/tmp',
      processAlive: true,
      now: 1000,
      makeId: () => 'id-1'
    })
    expect(first.raised?.id).toBe('id-1')
    expect(first.raised?.source).toBe('hermes-terminal')
    state = first.state

    const same = updateHermesApprovalTracker({
      state,
      chunkOrFullBuffer: REAL_PANEL + '\n',
      agentId: 'hermes',
      cwd: 'C:/tmp',
      processAlive: true,
      now: 2000,
      makeId: () => 'id-2'
    })
    expect(same.raised).toBeUndefined()
    expect(same.state.pending?.id).toBe('id-1')
    state = same.state

    const cleared = updateHermesApprovalTracker({
      state,
      chunkOrFullBuffer: 'command finished successfully\n',
      agentId: 'hermes',
      cwd: 'C:/tmp',
      processAlive: true,
      now: 3000
    })
    expect(cleared.cleared?.id).toBe('id-1')
    expect(cleared.cleared?.superseded).toBe(true)
    expect(cleared.state.pending).toBeNull()
  })

  it('does not keep approve keys after process death', () => {
    let state = createApprovalTrackerState()
    const first = updateHermesApprovalTracker({
      state,
      chunkOrFullBuffer: REAL_PANEL,
      agentId: 'hermes',
      cwd: 'C:/tmp',
      processAlive: true,
      now: 1000,
      makeId: () => 'dead-1'
    })
    state = first.state
    const dead = updateHermesApprovalTracker({
      state,
      chunkOrFullBuffer: REAL_PANEL,
      agentId: 'hermes',
      cwd: 'C:/tmp',
      processAlive: false,
      now: 2000
    })
    expect(dead.cleared?.processAlive).toBe(false)
    expect(dead.state.pending).toBeNull()
  })
})

describe('resolveHermesResponseKeys', () => {
  it('maps every Hermes permission choice to its digit', () => {
    const first = updateHermesApprovalTracker({
      state: createApprovalTrackerState(),
      chunkOrFullBuffer: REAL_PANEL,
      agentId: 'hermes',
      cwd: 'C:/tmp',
      processAlive: true,
      now: 1,
      makeId: () => 'x'
    })
    expect(resolveHermesResponseKeys(first.state, 'once')).toEqual({ ok: true, keys: '1' })
    expect(resolveHermesResponseKeys(first.state, 'session')).toEqual({ ok: true, keys: '2' })
    expect(resolveHermesResponseKeys(first.state, 'always')).toEqual({ ok: true, keys: '3' })
    expect(resolveHermesResponseKeys(first.state, 'deny')).toEqual({ ok: true, keys: '4' })
  })
})

describe('classifyCommandRisk', () => {
  it('flags destructive deletes as high', () => {
    expect(classifyCommandRisk('rm -rf /').level).toBe('high')
  })
  it('flags package installs as elevated', () => {
    expect(classifyCommandRisk('npm install lodash').level).toBe('elevated')
  })
})

describe('hermes panel kinds are kept apart', () => {
  it('ignores a slash-command confirmation', () => {
    // Bracketed rows plus a "Type 1/2/3" footer are Hermes' slash-command UI,
    // not a dangerous-command approval. Answering one as though it were a
    // permission grant would send a digit to a different question entirely.
    expect(detectHermesApprovalPanel(SLASH_CONFIRMATION)).toBeNull()
  })

  it('sends a bare digit, never a carriage return', () => {
    // v0.19.1 submits on the digit itself; a trailing \r arrives after the
    // panel has closed and lands in the composer.
    const detection = detectHermesApprovalPanel(REAL_PANEL)
    for (const keys of Object.values(detection?.responseKeys ?? {})) {
      expect(keys).toMatch(/^[0-9]$/)
    }
  })

  it('reads the description that sits below the choices', () => {
    const detection = detectHermesApprovalPanel(REAL_PANEL)
    expect(detection?.command).toBe('rm -rf node_modules')
  })

  it('handles the two-choice smart-deny panel', () => {
    const detection = detectHermesApprovalPanel(SMART_DENY_PANEL)
    expect(detection?.choices.map((c) => c.key)).toEqual(['once', 'deny'])
  })
})
