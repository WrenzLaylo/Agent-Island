/**
 * `island <agent> [args…]` — the shim that makes a real terminal session
 * visible to Agent Island.
 *
 * It runs *inside* the terminal you already have open. It does three things and
 * then gets out of the way:
 *
 *  1. Resolves which OS window is hosting it, by setting a unique title and
 *     looking for the window that now carries it (see `resolveHostWindow`).
 *  2. Publishes that window, plus its pid and cwd, to the session registry.
 *  3. Runs the real agent in a pty and pipes it straight through, so the user
 *     sees an ordinary session while the wrapper watches the output stream for
 *     prompts and republishes them for the island.
 *
 * It never opens a window, never renders a terminal, and never starts a second
 * agent. Exit code and stdio are transparent: if the wrapper fails for any
 * reason it must still leave the user with a working agent.
 */
import { spawnSync } from 'node:child_process'
import { spawn as ptySpawn, type IPty } from 'node-pty'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { discoverAgents } from '../main/agents/discover'
import { adapterEnv, buildLaunchSpec } from '../main/agents/launch'
import {
  createApprovalTrackerState,
  detectHermesApprovalPanel,
  resolveHermesResponseKeys,
  updateHermesApprovalTracker,
  type ApprovalTrackerState
} from '../main/agents/hermes-approval'
import {
  detectCodexApprovalPanel,
  resolveCodexResponseKeys,
  updateCodexApprovalTracker
} from '../main/agents/codex-approval'
import {
  detectClaudeApprovalPanel,
  resolveClaudeResponseKeys,
  updateClaudeApprovalTracker
} from '../main/agents/claude-approval'
import {
  createTerminalInputTrackerState,
  updateTerminalInputTracker,
  type TerminalInputTrackerState
} from '../main/agents/terminal-input'
import { normalizeTerminalText } from '../shared/ansi'
import { answersLivePrompt, mayAnswerSomePrompt } from '../shared/local-answer'
import { detectStalledPrompt } from '../shared/stalled-prompt'
import { AGENT_LABELS } from '../shared/contracts'
import type { AgentId, ApprovalDecision } from '../shared/contracts'
import {
  SESSION_HEARTBEAT_MS,
  type AgentSessionRecord,
  type SessionDecisionRecord,
  parseFocusRequest,
  type SessionPromptRecord,
  type TerminalKind
} from '../shared/session-registry'
import { decisionsDir, ensureRegistryDirs, focusDir, promptsDir, sessionsDir } from '../node/registry-paths'
import { findAncestorWindow, findWindowsByTitle } from '../node/win32-windows'

/** Control bytes, named rather than embedded raw in source. */
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ETX = String.fromCharCode(3)
/** Carriage return. Free text must be submitted; a digit choice must not. */
const CR = String.fromCharCode(13)
/** OSC introducer: ESC ] — the `]` is not optional. */
const OSC = `${ESC}]`

const SCAN_TAIL_CHARS = 24_000
const MAX_REPLAY = 80_000
const DECISION_POLL_MS = 200
/**
 * Quiet for this long and the agent is treated as finished. Long enough to ride
 * out the pauses inside a turn, short enough that "Working" ends when the turn
 * does.
 */
const IDLE_AFTER_MS = 2500

/**
 * How long a picker must sit untouched before the last-resort signal fires.
 *
 * Comfortably longer than IDLE_AFTER_MS: a real prompt waits indefinitely, so
 * there is no hurry, and the delay is what keeps a mid-render frame from being
 * mistaken for a stall. Nothing is lost by being slow here — this only ever
 * speaks when every real detector has already stayed silent.
 */
const STALL_AFTER_MS = 6000

/**
 * How long output must go quiet before the panel detector runs.
 *
 * A TUI repaint arrives as several chunks. Scanning on every chunk means
 * regularly fingerprinting a half-drawn panel, and a truncated choice label is
 * a different fingerprint — so the same request was raised again, and again,
 * landing in the island as two or three separate cards. Only the newest could
 * actually be answered (the wrapper honours a decision only for the live
 * prompt id), which is why answering appeared to take several attempts before
 * anything happened in the terminal.
 *
 * Waiting for a brief lull means the detector sees a complete frame.
 */
const SCAN_QUIET_MS = 90

/**
 * Upper bound on that wait. An agent streaming output continuously would
 * otherwise never fall quiet, and a panel printed in the middle of the stream
 * would never be detected at all.
 */
const SCAN_MAX_DELAY_MS = 400

/**
 * Set this terminal's title.
 *
 * Both mechanisms are used because neither covers everything: SetConsoleTitleW
 * (via `process.title`) drives Win32 consoles and Windows Terminal, while OSC 0
 * drives mintty, VS Code and other xterm-compatible emulators, which have no
 * Win32 console for the first call to act on.
 *
 * The OSC is written unconditionally: under ELECTRON_RUN_AS_NODE inside a
 * ConPTY, `process.stdout.isTTY` reports false even when stdout really is the
 * terminal, so gating on it silently disabled mintty support.
 */
function setTerminalTitle(value: string): void {
  try {
    process.title = value
  } catch {
    // Non-fatal; the OSC below may still work.
  }
  try {
    process.stdout.write(`${OSC}0;${value}${BEL}`)
  } catch {
    // ignore
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAgentId(value: string | undefined): value is AgentId {
  return value === 'claude' || value === 'codex' || value === 'hermes'
}

function usage(): never {
  process.stderr.write(
    'Usage: island <claude|codex|hermes> [args…]\n\n' +
      'Runs the agent in this terminal and makes the session visible to\n' +
      'Agent Island, so "Continue in Terminal" can bring this exact window\n' +
      'back to the front.\n'
  )
  process.exit(2)
}

/**
 * Find the OS window hosting this process.
 *
 * There is no API for "which window am I in". `GetConsoleWindow()` returns a
 * 0x0 pseudo-console inside Windows Terminal, and a Windows Terminal *process*
 * owns every one of its windows, so a pid lookup is ambiguous. What does work
 * on every host tested is a title handshake: set a unique title, find the
 * window now carrying it, put the title back.
 *
 * This must happen at startup, while this tab is still the active one — a
 * terminal's window title reflects its active tab, and shells overwrite the
 * title continuously afterwards. The HWND is cached from here on.
 */
async function resolveHostWindow(agentId: AgentId): Promise<{ hwnd: number | null; kind: TerminalKind; label: string }> {
  const marker = `agent-island-${randomUUID()}`
  const setTitle = setTerminalTitle

  let matches: Awaited<ReturnType<typeof findWindowsByTitle>> = []
  let searchError: string | null = null
  // Terminals apply a title change asynchronously, and anything else sharing
  // this console can overwrite it in between. Re-assert and re-look rather than
  // giving up after one attempt.
  for (let attempt = 0; attempt < 3 && matches.length === 0; attempt += 1) {
    setTitle(marker)
    try {
      matches = await findWindowsByTitle(marker)
    } catch (error) {
      searchError = String(error)
    }
    if (matches.length === 0) await delay(200)
  }
  setTitle(agentId)
  writeHandshakeDiagnostic(marker, matches, searchError)

  /*
   * Fall back to process ancestry when the title handshake finds nothing.
   *
   * An editor-hosted terminal cannot be found by title: VS Code drives its
   * window title from the active file, so the OSC sequence written above never
   * reaches it. Those sessions registered with hwnd: null and handoff could
   * only tell the user to switch across by hand.
   *
   * The handshake stays primary because it identifies the exact console, which
   * is what makes per-tab focus possible. Ancestry finds the hosting window
   * but knows nothing about which tab inside it is ours — better than nothing,
   * worse than the handshake, so it is only consulted once that has failed.
   */
  let hit: (typeof matches)[number] | null = matches[0] ?? null
  if (!hit) {
    try {
      hit = await findAncestorWindow(process.pid)
    } catch {
      // Non-fatal: the session still registers without a raisable window.
    }
  }
  if (!hit) {
    const kind: TerminalKind = process.env.TERM_PROGRAM === 'vscode' ? 'vscode' : 'unknown'
    return { hwnd: null, kind, label: kind === 'vscode' ? 'VS Code terminal' : 'Terminal' }
  }

  const cls = hit.className
  const kind: TerminalKind =
    cls === 'CASCADIA_HOSTING_WINDOW_CLASS'
      ? 'windows-terminal'
      : cls === 'mintty'
        ? 'mintty'
        : cls === 'ConsoleWindowClass'
          ? 'conhost'
          : process.env.TERM_PROGRAM === 'vscode'
            ? 'vscode'
            : 'unknown'
  const label =
    kind === 'windows-terminal'
      ? 'Windows Terminal'
      : kind === 'mintty'
        ? 'Git Bash'
        : kind === 'conhost'
          ? 'Console'
          : kind === 'vscode'
            ? 'VS Code terminal'
            : 'Terminal'
  return { hwnd: hit.hwnd, kind, label }
}

class SessionFiles {
  readonly sessionPath: string
  readonly promptPath: string
  readonly decisionPath: string

  constructor(readonly id: string) {
    this.sessionPath = join(sessionsDir(), `${id}.json`)
    this.promptPath = join(promptsDir(), `${id}.json`)
    this.decisionPath = join(decisionsDir(), `${id}.json`)
  }

  writeSession(record: AgentSessionRecord): void {
    writeAtomic(this.sessionPath, JSON.stringify(record, null, 2))
  }

  writePrompt(record: SessionPromptRecord): void {
    writeAtomic(this.promptPath, JSON.stringify(record, null, 2))
  }

  clearPrompt(): void {
    safeRemove(this.promptPath)
    safeRemove(this.decisionPath)
  }

  /**
   * Consume an answer without retiring the prompt.
   *
   * Needed when a decision arrives that cannot be turned into keystrokes: the
   * file has to go or the poll re-reads it forever, but the panel is still on
   * screen waiting, so the island must keep showing it.
   */
  clearDecision(): void {
    safeRemove(this.decisionPath)
  }

  readDecision(): SessionDecisionRecord | null {
    try {
      if (!existsSync(this.decisionPath)) return null
      const raw = readFileSync(this.decisionPath, 'utf8')
      const parsed = JSON.parse(raw.replace(/^﻿/, '')) as SessionDecisionRecord
      return parsed?.promptId ? parsed : null
    } catch {
      return null
    }
  }

  cleanup(): void {
    safeRemove(this.sessionPath)
    safeRemove(this.promptPath)
    safeRemove(this.decisionPath)
  }
}

function writeAtomic(target: string, contents: string): void {
  try {
    const tmp = `${target}.tmp`
    writeFileSync(tmp, contents, 'utf8')
    rmSync(target, { force: true })
    writeFileSync(target, contents, 'utf8')
    rmSync(tmp, { force: true })
  } catch {
    // The registry is advisory. Never take the user's agent down over it.
  }
}

function safeRemove(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // ignore
  }
}

/**
 * Diagnostics for the handshake, written whenever AGENT_ISLAND_WHOAMI_OUT is
 * set. Window resolution is the one part of this system that depends on the
 * host terminal behaving a particular way, so it has to be inspectable without
 * attaching a debugger to a process running inside someone's shell.
 */
function writeHandshakeDiagnostic(
  marker: string,
  matches: Array<{ hwnd: number; className: string; pid: number; title: string }>,
  searchError: string | null
): void {
  const target = process.env.AGENT_ISLAND_WHOAMI_OUT
  if (!target) return
  try {
    writeFileSync(
      target,
      JSON.stringify(
        {
          marker,
          isTTY: Boolean(process.stdout.isTTY),
          termProgram: process.env.TERM_PROGRAM ?? null,
          wtSession: process.env.WT_SESSION ?? null,
          searchError,
          matchCount: matches.length,
          matches
        },
        null,
        2
      ),
      'utf8'
    )
  } catch {
    // diagnostics only
  }
}

/**
 * `island --whoami` — report what the handshake can see from this terminal.
 * Users need a way to find out whether their terminal is supported without
 * starting an agent, and it is the first thing to run when handoff misbehaves.
 */
async function whoami(): Promise<void> {
  const host = await resolveHostWindow('claude')
  const lines = [
    `stdout is a TTY:   ${process.stdout.isTTY ? 'yes' : 'no'}`,
    `TERM_PROGRAM:      ${process.env.TERM_PROGRAM || '(unset)'}`,
    `WT_SESSION:        ${process.env.WT_SESSION || '(unset)'}`,
    `resolved terminal: ${host.label} (${host.kind})`,
    `window handle:     ${host.hwnd == null ? 'not found — handoff cannot raise this terminal' : String(host.hwnd)}`
  ]
  // stderr, not stdout: the handshake writes an OSC title sequence to stdout,
  // so anything redirecting stdout would swallow it and break the very thing
  // this command exists to report on.
  process.stderr.write(`${lines.join('\n')}\n`)

}

async function main(): Promise<void> {
  const [, , rawAgent, ...rest] = process.argv
  if (rawAgent === '--whoami') {
    await whoami()
    process.exit(0)
  }
  if (rawAgent === '--help' || rawAgent === '-h' || !rawAgent) usage()
  if (!isAgentId(rawAgent)) {
    process.stderr.write(`Unknown agent "${rawAgent}".\n`)
    usage()
  }
  const agentId: AgentId = rawAgent

  // Before anything else: discovery shells out to `<agent> --version`, and
  // those children share this console and can overwrite the title the
  // handshake relies on. Resolve the window while the terminal is untouched.
  ensureRegistryDirs()
  const host = await resolveHostWindow(agentId)

  const discovery = await discoverAgents()
  const agent = discovery.agents.find((item) => item.id === agentId)
  if (!agent?.available) {
    process.stderr.write(`${agentId} was not found on PATH.\n`)
    process.exit(127)
  }

  const launch = buildLaunchSpec(agent, process.cwd(), rest.length ? { args: rest } : undefined)
  if ('error' in launch) {
    process.stderr.write(`${launch.error}\n`)
    process.exit(127)
  }

  const id = randomUUID()
  const files = new SessionFiles(id)

  const record: AgentSessionRecord = {
    id,
    agentId,
    pid: process.pid,
    hwnd: host.hwnd,
    terminalKind: host.kind,
    terminalLabel: host.label,
    cwd: process.cwd(),
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    busy: false
  }
  files.writeSession(record)

  // Edge-triggered: the session file is rewritten only when the agent starts
  // or stops producing output, not on every chunk.
  let busy = false
  /*
   * The last screen we saw, so "output arrived" can be distinguished from
   * "something changed". A terminal repaints its input line constantly — a
   * cursor blink, a redraw after a resize — and treating every byte as work
   * pinned sessions at busy forever. Measured on an idle Hermes: 0ms of CPU
   * over three seconds, while the island showed it working indefinitely.
   */
  let lastVisibleText = ''
  let lastOutputAt = 0
  /** Stops one unread picker being reported on every poll while it sits there. */
  let lastStallFingerprint: string | null = null
  const publishBusy = (next: boolean) => {
    if (busy === next) return
    busy = next
    record.busy = next
    files.writeSession({ ...record, heartbeatAt: Date.now() })
  }
  const busyTimer = setInterval(() => {
    if (busy && Date.now() - lastOutputAt > IDLE_AFTER_MS) publishBusy(false)
  }, 500)
  busyTimer.unref?.()

  const heartbeat = setInterval(() => {
    files.writeSession({ ...record, heartbeatAt: Date.now() })
  }, SESSION_HEARTBEAT_MS)
  heartbeat.unref?.()

  const cols = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 120
  const rows = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 30

  let term: IPty
  try {
    // A string command line, not an array, whenever the spec is pre-quoted —
    // otherwise node-pty escapes the quotes and cmd.exe cannot find the shim.
    term = ptySpawn(launch.command, launch.verbatim && launch.commandLine ? launch.commandLine : launch.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: launch.cwd,
      env: {
        ...process.env,
        ...adapterEnv(agentId),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        AGENT_ISLAND: '1',
        AGENT_ISLAND_SESSION: id
      } as Record<string, string>
    })
  } catch (error) {
    clearInterval(heartbeat)
    files.cleanup()
    process.stderr.write(`Could not start ${agentId}: ${String(error)}\n`)
    process.exit(1)
  }

  let replay = ''
  let approval: ApprovalTrackerState = createApprovalTrackerState()
  let terminalInput: TerminalInputTrackerState = createTerminalInputTrackerState()
  let livePromptId: string | null = null

  const publishApproval = (request: {
    id: string
    summary: string
    detail: string
    cwd: string
    risk: SessionPromptRecord['risk']
    riskReason?: string
    expiresAt: number
    fingerprint?: string
    choices?: ApprovalDecision[]
    options?: Array<{ index: number; label: string }>
    choiceOptions?: Array<{ decision: ApprovalDecision; index: number; label: string }>
    isPermission?: boolean
  }) => {
    livePromptId = request.id
    // A numbered question is answerable, but it is not a permission grant and
    // must not reach the island wearing approve/deny language.
    const isChoice = request.isPermission === false
    files.writePrompt({
      sessionId: id,
      agentId,
      kind: isChoice ? 'choice' : 'approval',
      promptId: request.id,
      title: request.summary,
      detail: request.detail,
      cwd: request.cwd,
      createdAt: Date.now(),
      expiresAt: request.expiresAt,
      fingerprint: request.fingerprint ?? request.id,
      choices: isChoice ? undefined : request.choices,
      choiceOptions: isChoice ? undefined : request.choiceOptions,
      options: request.options,
      risk: request.risk,
      riskReason: request.riskReason
    })
  }

  const publishHandoff = (prompt: { id: string; title: string; detail?: string; expiresAt: number; fingerprint: string }) => {
    livePromptId = prompt.id
    files.writePrompt({
      sessionId: id,
      agentId,
      kind: 'handoff',
      promptId: prompt.id,
      title: prompt.title,
      detail: prompt.detail ?? '',
      cwd: process.cwd(),
      createdAt: Date.now(),
      expiresAt: prompt.expiresAt,
      fingerprint: prompt.fingerprint
    })
  }

  const clearPrompt = () => {
    livePromptId = null
    files.clearPrompt()
  }

  /** Fingerprint of whatever panel is on screen right now, without raising. */
  const currentPanelFingerprint = (): string | null => {
    const text = normalizeTerminalText(
      replay.length > SCAN_TAIL_CHARS ? replay.slice(-SCAN_TAIL_CHARS) : replay
    )
    const detection =
      agentId === 'hermes'
        ? detectHermesApprovalPanel(text)
        : agentId === 'codex'
          ? detectCodexApprovalPanel(text)
          : detectClaudeApprovalPanel(text)
    return detection?.fingerprint ?? null
  }

  const scan = () => {
    const text = normalizeTerminalText(replay.length > SCAN_TAIL_CHARS ? replay.slice(-SCAN_TAIL_CHARS) : replay)

    /*
     * Activity is a *change* on screen, not the arrival of bytes. This also
     * repairs stall detection, which reset its fingerprint on every chunk and
     * so could never fire for an agent whose prompt repaints.
     */
    if (text !== lastVisibleText) {
      lastVisibleText = text
      lastOutputAt = Date.now()
      lastStallFingerprint = null
      publishBusy(true)
    }

    const update =
      agentId === 'hermes'
        ? updateHermesApprovalTracker({
            state: approval,
            chunkOrFullBuffer: text,
            agentId,
            cwd: process.cwd(),
            processAlive: true
          })
        : agentId === 'codex'
          ? updateCodexApprovalTracker({
              state: approval,
              chunkOrFullBuffer: text,
              cwd: process.cwd(),
              processAlive: true
            })
          : updateClaudeApprovalTracker({
              state: approval,
              chunkOrFullBuffer: text,
              cwd: process.cwd(),
              processAlive: true
            })
    approval = update.state
    if (update.cleared) clearPrompt()
    if (update.raised) publishApproval(update.raised)

    const inputUpdate = updateTerminalInputTracker({
      state: terminalInput,
      chunkOrFullBuffer: text,
      agentId,
      cwd: process.cwd(),
      processAlive: true,
      suppress: Boolean(approval.pending)
    })
    terminalInput = inputUpdate.state
    if (inputUpdate.cleared) clearPrompt()
    if (inputUpdate.raised) publishHandoff(inputUpdate.raised)

    /*
     * Last resort, and only when everything else has stayed silent.
     *
     * If an adapter or the terminal-input detector recognised anything, that
     * is strictly better information and this must not second-guess it. What
     * remains is the case with no safe reading: an agent waiting on a panel
     * nobody parsed, which otherwise leaves the island perfectly calm while
     * the terminal is blocked.
     */
    if (!livePromptId && !approval.pending && Date.now() - lastOutputAt > STALL_AFTER_MS) {
      const stalled = detectStalledPrompt(text)
      if (stalled && stalled.fingerprint !== lastStallFingerprint) {
        lastStallFingerprint = stalled.fingerprint
        publishHandoff({
          id: `stall-${randomUUID()}`,
          title: `${AGENT_LABELS[agentId]} may be waiting for you`,
          // Deliberately hedged. Nothing here was understood, so claiming to
          // know what is being asked would be a lie the user acts on.
          detail: `Agent Island could not read this prompt. It looks like a choice with ${stalled.optionCount} options: ${stalled.preview}`,
          expiresAt: Date.now() + 30 * 60_000,
          fingerprint: stalled.fingerprint
        })
      }
    }
  }

  /*
   * Debounced scan: run once output has been quiet for SCAN_QUIET_MS, but
   * never later than SCAN_MAX_DELAY_MS after the first chunk of a burst.
   */
  let scanTimer: NodeJS.Timeout | null = null
  let scanDeadline = 0
  const scheduleScan = () => {
    const now = Date.now()
    if (scanTimer) {
      // Already inside a burst. Keep pushing the quiet window out, unless that
      // would take us past the deadline for this burst.
      if (now + SCAN_QUIET_MS > scanDeadline) return
      clearTimeout(scanTimer)
    } else {
      scanDeadline = now + SCAN_MAX_DELAY_MS
    }
    scanTimer = setTimeout(() => {
      scanTimer = null
      scan()
    }, SCAN_QUIET_MS)
    scanTimer.unref?.()
  }

  term.onData((data) => {
    // Deliberately does not touch `busy`: see the scan, which only counts
    // output that changes what is on screen.
    process.stdout.write(data)
    replay = (replay + data).slice(-MAX_REPLAY)
    scheduleScan()
  })

  // Answers arrive as files so the island can restart without losing them.
  const decisionPoll = setInterval(() => {
    if (!livePromptId) return
    const decision = files.readDecision()
    if (!decision || decision.promptId !== livePromptId) return
    const pending = approval.pending
    if (!pending || pending.id !== decision.promptId) {
      clearPrompt()
      return
    }
    /*
     * Three ways to answer, in order of directness.
     *
     * `text` and `optionIndex` bypass classification entirely: the island is
     * relaying what the user picked or typed, using the agent's own numbering.
     * Only a classified `choice` needs the responseKeys lookup, because that
     * is the one case where the island translated the agent's wording.
     */
    let payload: string | null = null
    if (typeof decision.text === 'string' && decision.text.length > 0) {
      // Strip control characters: the text goes straight into a live TTY, and
      // an embedded escape or newline would be interpreted, not typed.
      const safe = decision.text.replace(/[ -]/g, '').slice(0, 2000)
      if (safe.length > 0) payload = `${safe}${CR}`
    } else if (typeof decision.optionIndex === 'number' && Number.isFinite(decision.optionIndex)) {
      const index = Math.trunc(decision.optionIndex)
      // The digit must correspond to an option the agent actually printed.
      if (pending.options?.some((option) => option.index === index)) {
        payload = `${index}`
      }
    } else if (decision.choice) {
      const keys =
        agentId === 'hermes'
          ? resolveHermesResponseKeys(approval, decision.choice)
          : agentId === 'codex'
            ? resolveCodexResponseKeys(approval, decision.choice)
            : resolveClaudeResponseKeys(approval, decision.choice)
      if (keys.ok) payload = keys.keys
    }
    if (!payload) {
      /*
       * Nothing could be sent — most often an island newer than this wrapper
       * answering in a format it does not understand. Retiring the prompt here
       * would dismiss the card and leave the panel sitting unanswered in the
       * terminal, which reads as "I approved it and nothing happened". Drop
       * only the decision, so the card stays up and the failure is visible.
       */
      process.stderr.write(
        `island: could not act on that answer (prompt ${decision.promptId}). ` +
          `Restart this session so the wrapper matches the island.
`
      )
      files.clearDecision()
      return
    }
    try {
      term.write(payload)
    } catch {
      // The agent may have moved on; the next scan will resync.
    }
    approval = { pending: null, lastFingerprint: pending.fingerprint ?? null, responseKeys: null }
    clearPrompt()
  }, DECISION_POLL_MS)
  decisionPoll.unref?.()

  // Without a real console this is unusable, not merely degraded: keystrokes
  // stay line-buffered so the agent's TUI receives nothing, and VT sequences
  // are printed as literal text instead of being interpreted. Electron under
  // ELECTRON_RUN_AS_NODE is a GUI-subsystem binary and never attaches to the
  // console, which is exactly how this happens — so say so rather than handing
  // the user a frozen screen full of escape codes.
  /*
   * The island cannot know which tab hosts this session — the agent renames the
   * tab title constantly, so nothing set at startup survives. Instead the
   * island asks, here and now: it drops a marker string, this session paints it
   * as its title, the island finds the tab carrying it, and the title is put
   * back. Same handshake as window resolution, just repeated on demand.
   */
  const focusRequestPath = join(focusDir(), `${id}.json`)
  let focusMarkerActive = false
  const focusPoll = setInterval(() => {
    try {
      if (!existsSync(focusRequestPath)) {
        if (focusMarkerActive) {
          focusMarkerActive = false
          setTerminalTitle(agentId)
        }
        return
      }
      const request = parseFocusRequest(readFileSync(focusRequestPath, 'utf8'))
      if (!request || request.sessionId !== id) return
      // Re-assert every tick rather than setting it once. The agent repaints
      // its own tab title continuously — Claude rewrites it to "Claude Code"
      // within a few hundred milliseconds — so a marker written a single time
      // is gone before the island can look for it.
      focusMarkerActive = true
      setTerminalTitle(request.marker)
    } catch {
      // The island removes the request either way; nothing here is critical.
    }
  }, 150)
  focusPoll.unref?.()

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  } else {
    const advice = process.versions.electron
      ? 'island: run the wrapper with Node rather than Electron (install Node.js, or use the island launcher).'
      : 'island: try running it directly in a terminal window rather than through a pipe.'
    process.stderr.write(
      [
        `island: this terminal did not give the wrapper a console, so input would not reach ${agentId}.`,
        advice,
        `island: starting ${agentId} directly instead — Agent Island will not see this session.`,
        '',
        ''
      ].join('\n')
    )
    clearInterval(heartbeat)
    files.cleanup()
    /*
     * `windowsVerbatimArguments` because a .cmd launch spec already carries its
     * own quoting: `/d /s /c "C:\path\claude.cmd"`. Node's default escaping
     * wraps that again into `"\"C:\path\claude.cmd\""`, which cmd.exe rejects
     * with "is not recognized as an internal or external command" — so this
     * fallback could not start any npm-installed agent, which is all of them.
     */
    const direct = spawnSync(launch.command, launch.args, {
      stdio: 'inherit',
      cwd: launch.cwd,
      windowsVerbatimArguments: launch.verbatim === true
    })
    process.exit(direct.status ?? 0)
  }
  process.stdin.resume()
  process.stdin.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    /*
     * The user answered in the terminal rather than in the island.
     *
     * Output alone cannot tell us this quickly: a panel counts as live until
     * enough output follows it, and an agent that prints a short result after
     * being answered leaves the island showing a card for a settled request.
     * Keystrokes are the direct signal — see answersLivePrompt for why only a
     * real option digit or a submit counts.
     *
     * The answered fingerprint is retained exactly as it is when the island
     * answers, so the detector does not raise the same panel straight back.
     */
    if (livePromptId && approval.pending) {
      const offered = approval.pending.options?.map((option) => option.index) ?? []
      if (answersLivePrompt(text, offered)) {
        // Record which prompt this was before clearing it. Retiring a prompt
        // looks identical however it ended, so without this the island reports
        // the user's own answer as the request closing or expiring.
        record.answeredLocallyPromptId = livePromptId ?? undefined
        // Flushed rather than left to the 5s heartbeat: the island reads this
        // the moment it notices the prompt file has gone, which is far sooner.
        files.writeSession({ ...record, heartbeatAt: Date.now() })
        approval = {
          pending: null,
          lastFingerprint: approval.pending.fingerprint ?? null,
          responseKeys: null
        }
        clearPrompt()
      }
    } else if (scanTimer && mayAnswerSomePrompt(text)) {
      /*
       * Answered before the island ever showed it.
       *
       * Detection is debounced, so a panel can be on screen for up to
       * SCAN_MAX_DELAY_MS before it is raised. Answer inside that window and
       * the branch above has nothing to clear — then the pending scan finds
       * the panel still sitting in the replay buffer and raises a request the
       * user settled a moment ago. That is the "sometimes it persists" report.
       *
       * `scanTimer` being set is exactly that window: output has arrived and
       * has not been scanned yet. Outside it the buffer is already settled, so
       * this costs nothing on ordinary typing.
       *
       * Recording the fingerprint as already-answered is what stops the raise;
       * the detection is only to learn which panel that is.
       */
      const fingerprint = currentPanelFingerprint()
      if (fingerprint) {
        approval = { pending: null, lastFingerprint: fingerprint, responseKeys: null }
      }
    }
    try {
      term.write(text)
    } catch {
      // ignore writes to a dead pty
    }
  })

  const onResize = () => {
    const c = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : cols
    const r = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : rows
    try {
      term.resize(c, r)
    } catch {
      // ignore
    }
  }
  process.stdout.on('resize', onResize)

  const shutdown = (code: number) => {
    clearInterval(heartbeat)
    clearInterval(decisionPoll)
    clearInterval(busyTimer)
    clearInterval(focusPoll)
    safeRemove(focusRequestPath)
    files.cleanup()
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false)
      } catch {
        // ignore
      }
    }
    process.stdin.pause()
    process.exit(code)
  }

  term.onExit(({ exitCode }) => shutdown(exitCode ?? 0))
  process.on('SIGINT', () => {
    // Ctrl+C belongs to the agent, not the wrapper.
    try {
      term.write(ETX)
    } catch {
      shutdown(130)
    }
  })
  process.on('exit', () => {
    clearInterval(heartbeat)
    files.cleanup()
  })
}

main().catch((error) => {
  process.stderr.write(`island: ${String(error)}\n`)
  process.exit(1)
})
