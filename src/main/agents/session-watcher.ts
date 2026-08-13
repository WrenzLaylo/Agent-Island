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
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
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
import { isRunningCommand, processAlive } from '../../node/win32-windows'
import {
  PENDING_CALL_TTL_MS,
  permissionWasAsked,
  readPendingCalls,
  type PendingCall
} from '../../node/pending-calls'

const POLL_MS = 1000

/** Session ids published by hooks rather than by an `island` wrapper. */
const HOOK_SESSION_PREFIX = 'claude-hook-'

/**
 * How long a call stays open before the island shows it.
 *
 * `PreToolUse` and `PostToolUse` bracket every call, and the gap between them
 * covers two different situations that are indistinguishable from outside the
 * agent: a permission dialog waiting on a human, and a command that is simply
 * slow. Raising instantly would put a card in front of every tool call in the
 * session, which is unusable within seconds of real work.
 *
 * A delay separates most of them, because most calls return in well under a
 * second while a person reading a dialog takes far longer. It does not separate
 * all of them — a long build holds the gap open too — so the card says so in
 * that case rather than asserting something it cannot know. `Notification`
 * removes the doubt entirely in hosts that send it; the VS Code extension does
 * not, which is why this exists.
 */
export const CARD_GRACE_MS = 12_000

/**
 * How long a session file may stay unreadable before it is treated as debris.
 *
 * Well beyond any mid-write window, since the cost of waiting is a stale row
 * and the cost of being wrong is deleting a live session's record.
 */
export const CORRUPT_SESSION_TTL_MS = 60_000

/**
 * How long a session of unknown liveness may sit idle before it is reaped.
 *
 * Only reachable by a session whose record carries no usable pid — an older
 * Claude Code that does not export `CLAUDE_PID`. Judging one of those by
 * heartbeat is wrong (nothing heartbeats a hook-hosted session) and judging it
 * by pid is worse, because pid 0 fails a liveness test that "dead" and "cannot
 * tell" must not share. So it is judged by nothing but age, generously: the cost
 * of waiting is one stale row, and the cost of being wrong is deleting the card
 * a user is reading right now.
 */
export const UNKNOWN_LIVENESS_TTL_MS = 12 * 60 * 60_000

/**
 * Whether a record describes a session that is definitely gone.
 *
 * Kept pure, and taking its liveness test as an argument, because the bug this
 * replaces was a single `&&` that could not be exercised without a real process
 * tree: `isSessionStale(record) && !processAlive(record.pid)`.
 *
 * The flaw was in the second half. A record with no usable pid answers
 * `processAlive(0)` with false — the same answer a genuinely dead process gives
 * — so "cannot tell" and "dead" became the same verdict. Every hook-hosted
 * session was therefore deleted `SESSION_STALE_MS` after its last tool call,
 * taking its prompt file with it, during exactly the pause where the user is
 * reading the dialog the card mirrors.
 */
export function sessionShouldBeReaped(
  record: AgentSessionRecord,
  now: number,
  fileAgeMs: number,
  isAlive: (pid: number) => boolean = processAlive
): boolean {
  // A heartbeat is still the cheap first filter: anything checking in recently
  // is live whatever its pid says.
  if (!isSessionStale(record, now)) return false
  const hasPid = Number.isFinite(record.pid) && record.pid > 0
  if (!hasPid) return fileAgeMs > UNKNOWN_LIVENESS_TTL_MS
  return !isAlive(record.pid)
}

/**
 * Which call in flight, if any, deserves a card right now.
 *
 * The oldest one: it has been open longest, so it is the one a blocked session
 * is most likely blocked on. `certain` says whether the host actually told us
 * this is a permission, which is the difference between naming the situation
 * and guessing at it — and the card is worded from it.
 */
export function hookCardFor(
  calls: PendingCall[],
  now: number,
  permissionAsked: boolean
): { call: PendingCall; certain: boolean } | null {
  const oldest = newestBatch(calls)[0]
  if (!oldest) return null
  if (permissionAsked) return { call: oldest, certain: true }
  if (now - oldest.at >= CARD_GRACE_MS) return { call: oldest, certain: false }
  return null
}

/**
 * Calls issued together with the most recent one.
 *
 * A session waiting on a permission dialog cannot start new work — the turn is
 * blocked until the user answers. So a record with a later call after it was
 * never waiting on anything; it belongs to a call that has already finished and
 * said nothing about it.
 *
 * That happens because `PostToolUse` does not fire for a call that *failed*.
 * Measured: `node -e "process.exit(3)"` left its record open and still open
 * forty-five seconds later, where a successful call clears within one poll. The
 * card it produced named a command that had already exited.
 *
 * The window exists because Claude issues parallel calls in a burst, and those
 * arrive milliseconds apart — one of them may genuinely be the one being asked
 * about, so the whole burst stays eligible.
 */
const BATCH_WINDOW_MS = 2_000

function newestBatch(calls: PendingCall[]): PendingCall[] {
  if (calls.length < 2) return calls
  const newest = calls[calls.length - 1].at
  return calls.filter((call) => newest - call.at <= BATCH_WINDOW_MS)
}

function normaliseCwd(cwd: string | undefined): string {
  return String(cwd ?? '').replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * Whether an `island` wrapper is already watching this session's directory.
 *
 * The same hooks fire in a terminal, where the wrapper raises a card that can
 * actually be answered. Matched on cwd because the two mechanisms share no id:
 * the wrapper mints its own uuid and Claude Code mints another.
 */
export function wrapperOwnsCwd(
  sessions: Map<string, AgentSessionRecord>,
  record: AgentSessionRecord
): boolean {
  const target = normaliseCwd(record.cwd)
  if (!target) return false
  for (const other of sessions.values()) {
    if (other.id === record.id) continue
    if (other.id.startsWith(HOOK_SESSION_PREFIX)) continue
    if (other.agentId !== 'claude') continue
    if (normaliseCwd(other.cwd) === target) return true
  }
  return false
}

/** How long ago a file was last written, or 0 when it cannot be read. */
function fileAgeMs(path: string, now: number): number {
  try {
    return now - statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** True when the file exists and was last written longer ago than `ageMs`. */
function fileOlderThan(path: string, ageMs: number, now: number): boolean {
  return fileAgeMs(path, now) > ageMs
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
  /**
   * Per call: is it running (true), waiting (false), or still being asked
   * (null)? Keyed `sessionId:toolUseId` and dropped when the call closes, so
   * this cannot outgrow the calls actually in flight.
   */
  private callVerdicts = new Map<string, boolean | null>()
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

  /**
   * Turn calls that are still in flight into cards, and take them down again.
   *
   * Only for sessions published by hooks. A wrapper scrapes its terminal and
   * raises its own prompt — an *answerable* one, since it can type into that
   * session — so anything here would be the same question twice, one copy of
   * which does nothing.
   */
  /**
   * Is this call waiting for the user, or merely slow?
   *
   * Asked once per call, the first poll after its grace period elapses, and
   * remembered — the answer cannot change. Permission is requested before a
   * command runs, so a shell child at this moment means the user already
   * answered and the work is under way.
   *
   * `false` while the answer is outstanding. A card a few hundred milliseconds
   * late is a better failure than one raised on a guess and retracted.
   */
  private callIsWaiting(record: AgentSessionRecord, call: PendingCall): boolean {
    const key = `${record.id}:${call.toolUseId}`
    const verdict = this.callVerdicts.get(key)
    if (verdict === undefined) {
      this.callVerdicts.set(key, null)
      void isRunningCommand(record.pid).then(
        (running) => this.callVerdicts.set(key, running),
        () => this.callVerdicts.set(key, false)
      )
      return false
    }
    return verdict === null ? false : !verdict
  }

  private syncHookPrompts(sessions: Map<string, AgentSessionRecord>, now: number): void {
    const live = new Set<string>()
    for (const record of sessions.values()) {
      if (!record.id.startsWith(HOOK_SESSION_PREFIX)) continue
      const sessionId = record.id.slice(HOOK_SESSION_PREFIX.length)
      const target = join(promptsDir(), `${record.id}.json`)

      const card = wrapperOwnsCwd(sessions, record)
        ? null
        : hookCardFor(readPendingCalls(sessionId, now), now, permissionWasAsked(sessionId, now))

      if (!card) {
        if (existsSync(target)) rmSync(target, { force: true })
        continue
      }

      live.add(`${record.id}:${card.call.toolUseId}`)

      // `certain` came from Notification, which only fires for a real
      // permission, so there is nothing left to check. Everything else is a
      // guess until the process tree settles it.
      if (!card.certain && !this.callIsWaiting(record, card.call)) {
        if (existsSync(target)) rmSync(target, { force: true })
        continue
      }

      /*
       * Rewriting an identical card every second would mint a new promptId each
       * time, and the renderer keys its animation on that — the card would
       * re-enter once a second for as long as the user took to answer.
       */
      const fingerprint = `${record.id}-${card.call.toolUseId}-${card.certain}`
      if (existsSync(target)) {
        try {
          const existing = parsePromptRecord(readFileSync(target, 'utf8'))
          if (existing?.fingerprint === fingerprint) continue
        } catch {
          // Unreadable: fall through and replace it.
        }
      }

      const prompt: SessionPromptRecord = {
        sessionId: record.id,
        agentId: 'claude',
        // Never 'approval'. The island cannot answer this — there is no
        // terminal to type into and no decision file the extension reads — and
        // offering buttons that do nothing is worse than offering none.
        kind: 'handoff',
        promptId: `${record.id}-${card.call.toolUseId}`,
        title: card.certain ? 'Claude needs your permission' : 'Claude may need you',
        detail: card.call.command,
        cwd: card.call.cwd || record.cwd,
        createdAt: card.call.at,
        expiresAt: card.call.at + PENDING_CALL_TTL_MS,
        fingerprint
      }
      try {
        const tmp = `${target}.tmp`
        writeFileSync(tmp, JSON.stringify(prompt, null, 2), 'utf8')
        renameSync(tmp, target)
      } catch {
        // The next poll tries again.
      }
    }

    // A verdict is about one call, and is worthless the moment that call
    // closes. Dropping them here is what keeps the map the size of the work
    // actually in flight rather than the size of the session's history.
    for (const key of this.callVerdicts.keys()) {
      if (!live.has(key)) this.callVerdicts.delete(key)
    }
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
      // A stale heartbeat is only a hint; the pid is the truth, when there is
      // one to ask. See `sessionShouldBeReaped`.
      if (sessionShouldBeReaped(record, now, fileAgeMs(join(sessionsDir(), name), now))) {
        rmSync(join(sessionsDir(), name), { force: true })
        rmSync(join(promptsDir(), `${record.id}.json`), { force: true })
        rmSync(join(decisionsDir(), `${record.id}.json`), { force: true })
        continue
      }
      nextSessions.set(record.id, record)
    }

    // Before prompts are read, so a card synthesised now is picked up by the
    // same pass rather than the next one.
    this.syncHookPrompts(nextSessions, now)

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
