/**
 * Watches the session registry that `island <agent>` wrappers publish to.
 *
 * Agent Island owns no agent processes and no terminals. Everything it knows
 * about a live session arrives here: which agent, which OS window is hosting
 * it, and what prompt is currently on screen.
 *
 * Liveness is checked against the wrapper's pid, not just its heartbeat, so a
 * hard-killed wrapper is reaped instead of leaving a session the island would
 * happily try to raise.
 */
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import {
  isSessionStale,
  parsePromptRecord,
  parseSessionRecord,
  type AgentSessionRecord,
  type SessionDecisionRecord,
  type SessionPromptRecord
} from '../../shared/session-registry'
import { decisionsDir, ensureRegistryDirs, promptsDir, sessionsDir } from '../../node/registry-paths'
import { processAlive } from '../../node/win32-windows'

const POLL_MS = 1000

export interface SessionWatcherEvents {
  'session-added': (session: AgentSessionRecord) => void
  'session-removed': (session: AgentSessionRecord) => void
  'prompt-raised': (prompt: SessionPromptRecord, session: AgentSessionRecord) => void
  'prompt-cleared': (prompt: SessionPromptRecord) => void
}

export class SessionWatcher extends EventEmitter {
  private sessions = new Map<string, AgentSessionRecord>()
  private prompts = new Map<string, SessionPromptRecord>()
  private watchers: FSWatcher[] = []
  private timer: NodeJS.Timeout | null = null

  start(): void {
    ensureRegistryDirs()
    this.refresh()

    for (const dir of [sessionsDir(), promptsDir()]) {
      try {
        this.watchers.push(watch(dir, { persistent: true }, () => this.refresh()))
      } catch {
        // Polling below is the fallback.
      }
    }
    this.timer = setInterval(() => this.refresh(), POLL_MS)
  }

  stop(): void {
    for (const w of this.watchers) {
      try {
        w.close()
      } catch {
        // ignore
      }
    }
    this.watchers = []
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  listSessions(): AgentSessionRecord[] {
    return [...this.sessions.values()]
  }

  listPrompts(): SessionPromptRecord[] {
    return [...this.prompts.values()]
  }

  getSession(id: string): AgentSessionRecord | undefined {
    return this.sessions.get(id)
  }

  /** Most recently started live session for an agent, for the manual button. */
  newestSessionFor(agentId: AgentSessionRecord['agentId']): AgentSessionRecord | undefined {
    return this.listSessions()
      .filter((s) => s.agentId === agentId)
      .sort((a, b) => b.startedAt - a.startedAt)[0]
  }

  /** Island's answer to an approval. The wrapper picks this up and types it. */
  writeDecision(decision: SessionDecisionRecord): boolean {
    try {
      ensureRegistryDirs()
      writeFileSync(
        join(decisionsDir(), `${decision.sessionId}.json`),
        JSON.stringify(decision, null, 2),
        'utf8'
      )
      return true
    } catch {
      return false
    }
  }

  private readDir(dir: string): Array<{ name: string; raw: string }> {
    if (!existsSync(dir)) return []
    const out: Array<{ name: string; raw: string }> = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        out.push({ name, raw: readFileSync(join(dir, name), 'utf8') })
      } catch {
        // A wrapper may be mid-write; the next poll will catch it.
      }
    }
    return out
  }

  private refresh(): void {
    const now = Date.now()
    const nextSessions = new Map<string, AgentSessionRecord>()

    for (const { name, raw } of this.readDir(sessionsDir())) {
      const record = parseSessionRecord(raw)
      if (!record) continue
      // A stale heartbeat is only a hint; the pid is the truth. This is what
      // reaps a wrapper that was killed rather than exiting cleanly.
      if (isSessionStale(record, now) && !processAlive(record.pid)) {
        rmSync(join(sessionsDir(), name), { force: true })
        rmSync(join(promptsDir(), `${record.id}.json`), { force: true })
        rmSync(join(decisionsDir(), `${record.id}.json`), { force: true })
        continue
      }
      nextSessions.set(record.id, record)
    }

    for (const [id, record] of nextSessions) {
      if (!this.sessions.has(id)) this.emit('session-added', record)
    }
    for (const [id, record] of this.sessions) {
      if (!nextSessions.has(id)) this.emit('session-removed', record)
    }
    this.sessions = nextSessions

    const nextPrompts = new Map<string, SessionPromptRecord>()
    for (const { raw } of this.readDir(promptsDir())) {
      const record = parsePromptRecord(raw)
      if (!record) continue
      if (!nextSessions.has(record.sessionId)) continue
      nextPrompts.set(record.promptId, record)
    }

    for (const [promptId, record] of nextPrompts) {
      const previous = this.prompts.get(promptId)
      if (!previous) {
        const session = nextSessions.get(record.sessionId)
        if (session) this.emit('prompt-raised', record, session)
      }
    }
    for (const [promptId, record] of this.prompts) {
      if (!nextPrompts.has(promptId)) this.emit('prompt-cleared', record)
    }
    this.prompts = nextPrompts
  }
}
