/**
 * Drives the real, built wrapper against a scripted fake agent.
 *
 * Two env vars are enough to take full control, so nothing test-shaped has to
 * exist in production code:
 *
 *   PATH          `discoverAgents` calls `where <agent>` first and only falls
 *                 back to well-known install paths when that finds nothing, so
 *                 a PATH holding just the fake shim decides what gets spawned.
 *   LOCALAPPDATA  `registryRoot()` is derived from it, so the session, prompt
 *                 and decision files land in a temp dir instead of the user's
 *                 real registry — a suite run cannot disturb a live island.
 */
import { spawn as ptySpawn, type IPty } from 'node-pty'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionDecisionRecord, SessionPromptRecord } from '../../src/shared/session-registry'

const REPO = resolve(__dirname, '..', '..')
const WRAPPER = join(REPO, 'out', 'main', 'wrapper.js')
const FAKE_AGENT = join(REPO, 'tests', 'e2e', 'fake-agent.mjs')

export type AgentId = 'claude' | 'codex' | 'hermes'

export interface Step {
  type: 'emit' | 'sleep' | 'waitForInput'
  text?: string
  fixture?: string
  raw?: boolean
  ms?: number
  count?: number
  timeoutMs?: number
}

export interface StdinRecord {
  at: number
  bytes: number[]
}

/**
 * System directories the child still needs after PATH is replaced.
 *
 * cmd.exe and powershell.exe are launched by the wrapper (via ComSpec and the
 * window handshake). Dropping these makes the wrapper fail for reasons that
 * have nothing to do with the behaviour under test.
 */
function systemPath(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return [join(root, 'System32'), root, join(root, 'System32', 'WindowsPowerShell', 'v1.0')].join(';')
}

export class WrapperRun {
  readonly root: string
  readonly recordPath: string
  /**
   * The wrapper is hosted in a PTY rather than on pipes.
   *
   * Not a detail: with pipes `process.stdin.isTTY` is false, and the wrapper
   * deliberately refuses that case — it prints "this terminal did not give the
   * wrapper a console", skips node-pty entirely and execs the agent directly,
   * so nothing is ever scanned. A PTY is the only way to exercise the path a
   * user actually runs.
   */
  private child: IPty | null = null
  private exited = false
  private stdout = ''

  constructor(readonly agentId: AgentId) {
    this.root = mkdtempSync(join(tmpdir(), 'island-e2e-'))
    this.recordPath = join(this.root, 'stdin-record.jsonl')
  }

  /** Where the wrapper will write its registry files. */
  get registryRoot(): string {
    return join(this.root, 'agent-island')
  }

  private dir(name: string): string {
    return join(this.registryRoot, name)
  }

  start(steps: Step[], options: { tailMs?: number } = {}): void {
    const binDir = join(this.root, 'bin')
    mkdirSync(binDir, { recursive: true })

    const scenarioPath = join(this.root, 'scenario.json')
    writeFileSync(scenarioPath, JSON.stringify({ steps, tailMs: options.tailMs ?? 250 }, null, 2))

    // A .cmd shim, matching how npm actually installs these agents — which is
    // the path `buildLaunchSpec` treats specially by routing through ComSpec.
    // node is referenced absolutely so the shim does not depend on PATH.
    const shim = [
      '@echo off',
      `"${process.execPath}" "${FAKE_AGENT}" %*`,
      ''
    ].join('\r\n')
    writeFileSync(join(binDir, `${this.agentId}.cmd`), shim)

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value
    }
    // Both spellings: Windows env is case-insensitive, but this object is not,
    // and leaving the inherited `Path` in place would restore the real PATH.
    delete env.Path
    env.PATH = `${binDir};${systemPath()}`
    env.LOCALAPPDATA = this.root
    env.FAKE_AGENT_SCENARIO = scenarioPath
    env.FAKE_AGENT_RECORD = this.recordPath

    this.child = ptySpawn(process.execPath, [WRAPPER, this.agentId], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: this.root,
      env,
      /*
       * winpty, not ConPTY, for the *outer* host only.
       *
       * The wrapper opens a ConPTY of its own for the agent. Nesting one
       * ConPTY inside another makes node-pty's console-list helper call
       * AttachConsole against a pseudoconsole it cannot attach to; it throws
       * "AttachConsole failed" and the wrapper dies before it scans anything.
       * winpty hands out a real console handle, so the inner ConPTY — the one
       * under test — behaves exactly as it does for a user.
       */
      useConpty: false
    })
    this.child.onData((data) => {
      this.stdout += data
    })
    this.child.onExit(() => {
      this.exited = true
    })
  }

  /** Everything the wrapper printed, for diagnosing a failed expectation. */
  output(): { stdout: string; stderr: string } {
    // A PTY merges both streams; kept as two fields so callers read naturally.
    return { stdout: this.stdout, stderr: '' }
  }

  /** Bytes the fake agent has received so far, in arrival order. */
  keystrokes(): StdinRecord[] {
    try {
      return readFileSync(this.recordPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as StdinRecord)
    } catch {
      return []
    }
  }

  /** Everything the fake agent received, decoded, as one string. */
  keystrokeText(): string {
    return this.keystrokes()
      .map((entry) => Buffer.from(entry.bytes).toString('utf8'))
      .join('')
  }

  private readJsonDir<T>(name: string): T[] {
    try {
      return readdirSync(this.dir(name))
        .filter((file) => file.endsWith('.json'))
        .map((file) => {
          const raw = readFileSync(join(this.dir(name), file), 'utf8')
          return JSON.parse(raw.replace(/^\uFEFF/, '')) as T
        })
    } catch {
      return []
    }
  }

  sessions(): Array<{ id: string; agentId: AgentId; pid: number; hwnd: number | null; cwd: string }> {
    return this.readJsonDir('sessions')
  }

  prompts(): SessionPromptRecord[] {
    return this.readJsonDir('prompts')
  }

  /** Answer a prompt the way the island does: by writing a decision file. */
  decide(decision: SessionDecisionRecord): void {
    const dir = this.dir('decisions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${decision.sessionId}.json`), JSON.stringify(decision, null, 2))
  }

  /**
   * Generous by default: the wrapper spends roughly eight seconds resolving
   * its host window through PowerShell before the agent is even spawned, so a
   * timeout tuned to the scan itself would only ever measure that handshake.
   */
  async waitFor<T>(label: string, probe: () => T | null | undefined, timeoutMs = 40_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    let last: T | null | undefined
    while (Date.now() < deadline) {
      last = probe()
      if (last !== null && last !== undefined && !(Array.isArray(last) && last.length === 0)) {
        return last as T
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    const { stdout, stderr } = this.output()
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for ${label}\n` +
        `--- wrapper stdout ---\n${stdout.slice(-2000)}\n` +
        `--- wrapper stderr ---\n${stderr.slice(-2000)}\n` +
        `--- keystrokes ---\n${JSON.stringify(this.keystrokeText())}`
    )
  }

  /** Resolves when the wrapper exits, or after `timeoutMs`. */
  async waitForExit(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this.exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  async dispose(): Promise<void> {
    if (this.child && !this.exited) {
      try {
        this.child.kill()
      } catch {
        // Already gone; nothing to clean up on the process side.
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    try {
      rmSync(this.root, { recursive: true, force: true })
    } catch {
      // A ConPTY can hold a handle briefly after exit; a leaked temp dir is
      // not worth failing a passing test over.
    }
  }
}
