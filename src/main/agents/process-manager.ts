import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import * as pty from 'node-pty'
import type { AgentId, ApprovalRequest } from '../../shared/contracts'
import {
  MAX_REPLAY_CHARS,
  type PtyExitEvent,
  type PtySessionInfo,
  type PtyStartResult,
  validateSize
} from '../../shared/pty-types'
import type { DiscoveredAgent } from './discover'
import { adapterEnv, buildLaunchSpec } from './launch'
import {
  createApprovalTrackerState,
  resolveHermesResponseKeys,
  updateHermesApprovalTracker,
  type ApprovalTrackerState
} from './hermes-approval'
import { canApproveRequest } from '../../shared/approval-guard'

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
  lastOutputAt: number
  approval: ApprovalTrackerState
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

  getPendingApproval(agentId: AgentId): ApprovalRequest | null {
    return this.sessions.get(agentId)?.approval.pending ?? null
  }

  isAlive(agentId: AgentId): boolean {
    return Boolean(this.sessions.get(agentId)?.info.alive)
  }

  start(
    agentId: AgentId,
    agent: DiscoveredAgent | undefined,
    cols: number,
    rows: number,
    cwd?: string
  ): PtyStartResult {
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

    if (!agent) {
      return { ok: false, error: `${agentId} is unavailable` }
    }

    const launchOrError = buildLaunchSpec(agent, cwd ?? this.defaultCwd)
    if ('error' in launchOrError) {
      return { ok: false, error: launchOrError.error }
    }
    const launch = launchOrError

    if (!existsSync(agent.path ?? launch.command) && !existsSync(launch.command)) {
      return { ok: false, error: `Executable missing: ${agent.path ?? launch.command}` }
    }

    try {
      const term = this.spawnFn(launch.command, launch.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: launch.cwd,
        env: {
          ...process.env,
          ...adapterEnv(agentId),
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
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
        replay: '',
        lastOutputAt: Date.now(),
        approval: createApprovalTrackerState()
      }
      this.sessions.set(agentId, session)
      this.emit('session', { ...info })

      term.onData((data) => {
        session.replay = appendReplay(session.replay, data, MAX_REPLAY_CHARS)
        session.lastOutputAt = Date.now()
        this.emit('data', { agentId, data })
        this.scanApprovals(session)
      })

      term.onExit(({ exitCode, signal }) => {
        session.info.alive = false
        this.scanApprovals(session)
        const event: PtyExitEvent = {
          agentId,
          exitCode: exitCode ?? 0,
          signal: typeof signal === 'number' ? signal : undefined
        }
        this.emit('exit', event)
        this.emit('session', { ...session.info })
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

  answerApproval(
    agentId: AgentId,
    requestId: string,
    decision: 'approve' | 'deny'
  ): { ok: boolean; error?: string } {
    const session = this.sessions.get(agentId)
    if (!session) return { ok: false, error: 'No session' }
    if (agentId !== 'hermes') {
      return { ok: false, error: 'Island approvals only supported for Hermes in Phase 4' }
    }

    this.scanApprovals(session)
    const pending = session.approval.pending
    if (!pending || pending.id !== requestId) {
      return { ok: false, error: 'No matching pending approval' }
    }

    const guard = canApproveRequest({
      request: {
        ...pending,
        processAlive: session.info.alive
      },
      displayedRequestId: requestId
    })
    if (decision === 'approve' && !guard.canApprove) {
      return { ok: false, error: guard.reason ?? 'Approve blocked by safety guard' }
    }
    if (decision === 'deny' && (pending.answered || !session.info.alive)) {
      return { ok: false, error: 'Cannot deny this request' }
    }

    const recheck = updateHermesApprovalTracker({
      state: session.approval,
      chunkOrFullBuffer: session.replay,
      agentId,
      cwd: session.info.cwd,
      processAlive: session.info.alive
    })
    session.approval = recheck.state
    if (
      !session.approval.pending ||
      session.approval.pending.fingerprint !== pending.fingerprint ||
      session.approval.pending.id !== requestId
    ) {
      return { ok: false, error: 'Approval panel changed or disappeared — open terminal' }
    }

    const keys = resolveHermesResponseKeys(session.approval, decision)
    if (!keys.ok) return { ok: false, error: keys.reason }

    try {
      session.term.write(keys.keys)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    this.emit('approval-answered', {
      agentId,
      requestId,
      decision
    })
    session.approval = {
      pending: null,
      lastFingerprint: pending.fingerprint ?? null,
      responseKeys: null
    }
    return { ok: true }
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
        try {
          session.term.write('\u0003')
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
    this.emit('session', { ...session.info, alive: false })
    return { ok: true }
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()]
    await Promise.all(ids.map((id) => this.stop(id, true)))
  }

  private scanApprovals(session: LiveSession): void {
    if (session.agentId !== 'hermes') return
    const update = updateHermesApprovalTracker({
      state: session.approval,
      chunkOrFullBuffer: session.replay,
      agentId: session.agentId,
      cwd: session.info.cwd,
      processAlive: session.info.alive
    })
    session.approval = update.state
    if (update.cleared) {
      this.emit('approval-cleared', update.cleared)
    }
    if (update.raised) {
      this.emit('approval', update.raised)
    }
  }
}

/** @deprecated Prefer buildLaunchSpec via launch.ts — kept for older tests. */
export function resolveLaunchSpec(agentId: AgentId, executable: string, cwd: string): LaunchSpec {
  const lower = executable.toLowerCase()
  const needsShell = lower.endsWith('.cmd') || lower.endsWith('.bat')
  if (needsShell) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${executable}"`],
      cwd
    }
  }
  void agentId
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
