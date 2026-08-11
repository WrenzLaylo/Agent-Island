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
import { existsSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
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

/**
 * How long a session file may stay unreadable before it is treated as debris.
 *
 * Well beyond any mid-write window, since the cost of waiting is a stale row
 * and the cost of being wrong is deleting a live session's record.
 */
export const CORRUPT_SESSION_TTL_MS = 60_000

/** True when the file exists and was last written longer ago than `ageMs`. */
function fileOlderThan(path: string, ageMs: number, now: number): boolean {
  try {
    return now - statSync(path).mtimeMs > ageMs
  } catch {
    return false
  }
}

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
      if (!record) {
        // Unparseable, so there is no pid to test liveness against, and the
        // reaper below can never see it — such a file used to survive forever.
        // Three had accumulated on the development machine, each 291 bytes of
        // NUL: the shape NTFS leaves behind when a file's length is extended
        // but its data never reaches disk before a hard shutdown.
        //
        // Age is the only usable signal. The window is generous because a
        // wrapper mid-write is briefly unparseable too, and deleting a live
        // session's file would strand its prompts.
        if (fileOlderThan(join(sessionsDir(), name), CORRUPT_SESSION_TTL_MS, now)) {
          rmSync(join(sessionsDir(), name), { force: true })
        }
        continue
      }
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

    // Emit in the order the agents asked. `readdir` order is arbitrary.
    const raised = [...nextPrompts.values()]
      .filter((record) => !this.prompts.has(record.promptId))
      .sort((left, right) => left.createdAt - right.createdAt)
    for (const record of raised) {
      const session = nextSessions.get(record.sessionId)
      if (session) this.emit('prompt-raised', record, session)
    }
    for (const [promptId, record] of this.prompts) {
      if (!nextPrompts.has(promptId)) this.emit('prompt-cleared', record)
    }
    this.prompts = nextPrompts
  }
}
