import { describe, expect, it } from 'vitest'
import { stripAnsi } from '../../src/shared/ansi'
import {
  detectHermesApprovalPanel,
  updateHermesApprovalTracker,
  resolveHermesResponseKeys,
  createApprovalTrackerState,
  classifyCommandRisk
} from '../../src/main/agents/hermes-approval'

const REAL_PANEL = `
some agent output...
╭──────────────────────────────────────────────╮
│ ⚠️  Dangerous Command                        │
│                                              │
│ rm -rf node_modules                          │
│                                              │
│ This will permanently delete files.          │
│                                              │
│ ❯ [1] Allow once — run this command once     │
│   [2] Allow for this session — remember now  │
│   [3] Add to permanent allowlist — save it   │
│   [4] Deny — block this command              │
│                                              │
│ Type 1/2/3 or use ↑/↓ then Enter. ESC/Ctrl+C cancels. │
╰──────────────────────────────────────────────╯
`

const SMART_DENY_PANEL = `
╭────────────────────────────╮
│ ⚠️  Dangerous Command      │
│                            │
│ git push --force origin m  │
│                            │
│ [1] Allow once             │
│ [2] Deny                   │
│ Type 1/2/3 or use ↑/↓ then Enter. ESC/Ctrl+C cancels. │
╰────────────────────────────╯
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
    expect(hit?.responseKeys.once).toBe('1\r')
    expect(hit?.responseKeys.session).toBe('2\r')
    expect(hit?.responseKeys.always).toBe('3\r')
    expect(hit?.responseKeys.deny).toBe('4\r')
    expect(hit?.risk).toBe('high')
  })

  it('detects smart-deny two-choice panels', () => {
    const hit = detectHermesApprovalPanel(SMART_DENY_PANEL)
    expect(hit).not.toBeNull()
    expect(hit?.responseKeys.once).toBe('1\r')
    expect(hit?.responseKeys.deny).toBe('2\r')
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
    expect(resolveHermesResponseKeys(first.state, 'once')).toEqual({ ok: true, keys: '1\r' })
    expect(resolveHermesResponseKeys(first.state, 'session')).toEqual({ ok: true, keys: '2\r' })
    expect(resolveHermesResponseKeys(first.state, 'always')).toEqual({ ok: true, keys: '3\r' })
    expect(resolveHermesResponseKeys(first.state, 'deny')).toEqual({ ok: true, keys: '4\r' })
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
