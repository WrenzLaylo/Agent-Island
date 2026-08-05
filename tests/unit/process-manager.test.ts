import { describe, expect, it, vi } from 'vitest'
import {
  appendReplay,
  resolveLaunchSpec,
  PtyManager
} from '../../src/main/agents/process-manager'
import { isAgentId, validateSize } from '../../src/shared/pty-types'

describe('pty helpers', () => {
  it('validates agent ids', () => {
    expect(isAgentId('hermes')).toBe(true)
    expect(isAgentId('nope')).toBe(false)
  })

  it('validates terminal sizes', () => {
    expect(validateSize(80, 24)).toBeNull()
    expect(validateSize(10, 24)).toBe('cols out of range')
    expect(validateSize(80, 2)).toBe('rows out of range')
  })

  it('trims replay buffer from the front', () => {
    expect(appendReplay('abcdef', 'ghij', 8)).toBe('cdefghij')
    expect(appendReplay('abc', 'd', 100)).toBe('abcd')
  })

  it('launches hermes executable directly', () => {
    const spec = resolveLaunchSpec(
      'hermes',
      'C:/Users/OASIS/AppData/Local/hermes/hermes-agent/venv/Scripts/hermes.exe',
      'C:/tmp'
    )
    expect(spec.command.endsWith('hermes.exe')).toBe(true)
    expect(spec.args).toEqual([])
    expect(spec.cwd).toBe('C:/tmp')
  })

  it('wraps windows cmd shims', () => {
    const spec = resolveLaunchSpec('codex', 'C:/Users/OASIS/AppData/Roaming/npm/codex.cmd', 'C:/proj')
    expect(spec.command.toLowerCase()).toContain('cmd')
    expect(spec.args.join(' ')).toContain('codex.cmd')
  })
})

describe('PtyManager with fake spawn', () => {
  it('starts, writes, resizes, and stops a session', async () => {
    const writes: string[] = []
    const resizes: Array<[number, number]> = []
    let dataHandler: ((d: string) => void) | undefined
    let exitHandler: ((e: { exitCode: number; signal?: number }) => void) | undefined

    const fakeTerm = {
      pid: 4242,
      write: (data: string) => writes.push(data),
      resize: (cols: number, rows: number) => resizes.push([cols, rows]),
      kill: vi.fn(() => {
        exitHandler?.({ exitCode: 0 })
      }),
      onData: (cb: (d: string) => void) => {
        dataHandler = cb
      },
      onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
        exitHandler = cb
      }
    }

    const spawn = vi.fn(() => fakeTerm as never)
    const manager = new PtyManager({ spawn, forceKillMs: 10, defaultCwd: 'C:/work' })

    const ok = manager.start(
      'hermes',
      {
        id: 'hermes',
        label: 'Hermes',
        available: true,
        path: process.execPath,
        integrationMode: 'terminal-basic'
      },
      100,
      30
    )

    expect(ok.ok).toBe(true)
    expect(ok.session?.pid).toBe(4242)

    const dataEvents: string[] = []
    manager.on('data', (evt: { data: string }) => dataEvents.push(evt.data))
    dataHandler?.('hello')
    expect(dataEvents).toEqual(['hello'])
    expect(manager.getReplay('hermes')).toBe('hello')

    expect(manager.write('hermes', 'ls\r')).toEqual({ ok: true })
    expect(writes).toContain('ls\r')
    expect(manager.resize('hermes', 120, 40)).toEqual({ ok: true })
    expect(resizes).toEqual([[120, 40]])

    await manager.stop('hermes', true)
    expect(fakeTerm.kill).toHaveBeenCalled()
  })



  it('bridges Codex command approvals to the island', () => {
    const writes: string[] = []
    let dataHandler: ((d: string) => void) | undefined
    const fakeTerm = {
      pid: 5252,
      write: (data: string) => writes.push(data),
      resize: () => undefined,
      kill: () => undefined,
      onData: (cb: (d: string) => void) => { dataHandler = cb },
      onExit: () => undefined
    }
    const manager = new PtyManager({ spawn: vi.fn(() => fakeTerm as never), defaultCwd: 'C:/repo' })
    const started = manager.start(
      'codex',
      {
        id: 'codex',
        label: 'Codex',
        available: true,
        path: process.execPath,
        integrationMode: 'terminal-known'
      },
      100,
      30
    )
    expect(started.ok).toBe(true)

    let requestId = ''
    manager.on('approval', (request: { id: string }) => { requestId = request.id })
    dataHandler?.(`
Would you like to run the following command?

Reason: Network access is required.

$ curl -L https://example.com/

1. Yes, proceed (y)
2. Yes, and don't ask again for commands that start with \`curl\` (p)
3. No, and tell Codex what to do differently (esc)

Press enter to confirm or esc to cancel
`)
    expect(requestId).not.toBe('')
    expect(manager.answerApproval('codex', requestId, 'always')).toEqual({ ok: true })
    expect(writes).toContain('p')
  })

  it('rejects unavailable agents', () => {
    const manager = new PtyManager({
      spawn: vi.fn() as never,
      forceKillMs: 10
    })
    const result = manager.start(
      'codex',
      {
        id: 'codex',
        label: 'Codex',
        available: false,
        integrationMode: 'unavailable',
        notes: 'not found'
      },
      80,
      24
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found|unavailable/i)
  })
})
