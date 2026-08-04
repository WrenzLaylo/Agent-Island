import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import * as pty from 'node-pty'
import type { AgentId } from '../../shared/contracts'
import {
  MAX_REPLAY_CHARS,
  type PtyExitEvent,
  type PtySessionInfo,
  type PtyStartResult,
  validateSize
} from '../../shared/pty-types'
import type { DiscoveredAgent } from './discover'

export interface LaunchSpec {
  command: string
  args: string[]
  cwd: string
}

export interface PtyManagerOptions {
  defaultCwd?: string
  forceKillMs?: number
  spawn?: typeof pty.spawn
}

interface LiveSession {
  agentId: AgentId
  term: pty.IPty
  info: PtySessionInfo
  replay: string
}

export class PtyManager extends EventEmitter {
  private sessions = new Map<AgentId, LiveSession>()
  private readonly defaultCwd: string
  private readonly forceKillMs: number
  private readonly spawnFn: typeof pty.spawn

  constructor(options: PtyManagerOptions = {}) {
    super()
    this.defaultCwd = options.defaultCwd ?? process.cwd()
    this.forceKillMs = options.forceKillMs ?? 2500
    this.spawnFn = options.spawn ?? pty.spawn
  }

  list(): PtySessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }))
  }

  get(agentId: AgentId): PtySessionInfo | undefined {
    const session = this.sessions.get(agentId)
    return session ? { ...session.info } : undefined
  }

  getReplay(agentId: AgentId): string {
    return this.sessions.get(agentId)?.replay ?? ''
  }

  start(agentId: AgentId, agent: DiscoveredAgent | undefined, cols: number, rows: number, cwd?: string): PtyStartResult {
    const sizeError = validateSize(cols, rows)
    if (sizeError) return { ok: false, error: sizeError }

    const existing = this.sessions.get(agentId)
    if (existing?.info.alive) {
      return {
        ok: true,
        session: { ...existing.info },
        replay: existing.replay
      }
    }

    if (existing) {
      this.sessions.delete(agentId)
    }

    if (!agent?.available || !agent.path) {
      return {
        ok: false,
        error: agent?.notes ?? `${agentId} is unavailable`
      }
    }

    if (!existsSync(agent.path)) {
      return { ok: false, error: `Executable missing: ${agent.path}` }
    }

    const launch = resolveLaunchSpec(agentId, agent.path, cwd ?? this.defaultCwd)

    try {
      const term = this.spawnFn(launch.command, launch.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: launch.cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          // Help CLIs detect an interactive terminal hosted by Agent Island.
          AGENT_ISLAND: '1'
        } as Record<string, string>
      })

      const info: PtySessionInfo = {
        agentId,
        alive: true,
        pid: term.pid,
        cwd: launch.cwd,
        cols,
        rows,
        command: [launch.command, ...launch.args].join(' '),
        startedAt: Date.now()
      }

      const session: LiveSession = {
        agentId,
        term,
        info,
        replay: ''
      }
      this.sessions.set(agentId, session)

      term.onData((data) => {
        session.replay = appendReplay(session.replay, data, MAX_REPLAY_CHARS)
        this.emit('data', { agentId, data })
      })

      term.onExit(({ exitCode, signal }) => {
        session.info.alive = false
        const event: PtyExitEvent = {
          agentId,
          exitCode: exitCode ?? 0,
          signal: typeof signal === 'number' ? signal : undefined
        }
        this.emit('exit', event)
      })

      return { ok: true, session: { ...info }, replay: '' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  }

  write(agentId: AgentId, data: string): { ok: boolean; error?: string } {
    const session = this.sessions.get(agentId)
    if (!session?.info.alive) return { ok: false, error: 'Session not running' }
    try {
      session.term.write(data)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  resize(agentId: AgentId, cols: number, rows: number): { ok: boolean; error?: string } {
    const sizeError = validateSize(cols, rows)
    if (sizeError) return { ok: false, error: sizeError }
    const session = this.sessions.get(agentId)
    if (!session?.info.alive) return { ok: false, error: 'Session not running' }
    try {
      session.term.resize(cols, rows)
      session.info.cols = cols
      session.info.rows = rows
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async stop(agentId: AgentId, force = false): Promise<{ ok: boolean; error?: string }> {
    const session = this.sessions.get(agentId)
    if (!session) return { ok: true }

    if (!session.info.alive) {
      this.sessions.delete(agentId)
      return { ok: true }
    }

    try {
      if (force) {
        session.term.kill()
      } else {
        // Prefer a gentle exit signal for interactive CLIs.
        try {
          session.term.write('\u0003') // Ctrl+C
        } catch {
          // ignore
        }
        session.term.kill()
      }
    } catch (error) {
      this.sessions.delete(agentId)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    await wait(this.forceKillMs)
    if (session.info.alive) {
      try {
        session.term.kill()
      } catch {
        // ignore
      }
    }
    this.sessions.delete(agentId)
    return { ok: true }
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()]
    await Promise.all(ids.map((id) => this.stop(id, true)))
  }
}

export function resolveLaunchSpec(agentId: AgentId, executable: string, cwd: string): LaunchSpec {
  // On Windows, .cmd shims need a shell. Direct .exe paths can run as-is.
  const lower = executable.toLowerCase()
  const needsShell = lower.endsWith('.cmd') || lower.endsWith('.bat')

  if (needsShell) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${executable}"`],
      cwd
    }
  }

  // Prefer launching agents in their normal interactive mode (no -q).
  if (agentId === 'hermes') {
    return { command: executable, args: [], cwd }
  }
  if (agentId === 'claude') {
    return { command: executable, args: [], cwd }
  }
  if (agentId === 'codex') {
    return { command: executable, args: [], cwd }
  }
  return { command: executable, args: [], cwd }
}

export function appendReplay(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk
  if (next.length <= maxChars) return next
  return next.slice(next.length - maxChars)
}

export function defaultShellLaunch(cwd = process.cwd()): LaunchSpec {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: [],
      cwd
    }
  }
  return {
    command: process.env.SHELL || '/bin/bash',
    args: ['-l'],
    cwd
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function shellHomeCwd(): string {
  try {
    return homedir()
  } catch {
    return process.cwd()
  }
}
