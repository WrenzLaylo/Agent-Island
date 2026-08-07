import type { AgentId, TerminalInputKind, TerminalInputPrompt } from '../../shared/contracts'
import { normalizeTerminalText } from '../../shared/ansi'
import { fingerprintDetection } from './hermes-approval'

export interface TerminalInputDetection {
  kind: TerminalInputKind
  title: string
  detail: string
  fingerprint: string
}

export interface TerminalInputTrackerState {
  pending: TerminalInputPrompt | null
  lastFingerprint: string | null
  /** A prompt already handed to the terminal should not immediately reopen the island. */
  dismissedFingerprint: string | null
}

export interface TerminalInputTrackerUpdate {
  state: TerminalInputTrackerState
  raised?: TerminalInputPrompt
  cleared?: TerminalInputPrompt
}

const EXPLICIT_APPROVAL_RE =
  /Dangerous Command|Would you like to run the following command\?|Would you like to make the following edits\?/i

const PLAN_RE =
  /\b(plan mode|proposed plan|implementation plan|ready to implement|ready to proceed|would you like to (?:proceed|implement|continue)|how would you like (?:me|the agent|claude|codex|hermes) to proceed|review (?:this|the) plan)\b/i

const AUTH_RE =
  /\b(sign in|log in|authenticate|authentication required|open the browser to continue|enter (?:the )?(?:code|token|password)|paste (?:the )?(?:code|token))\b/i

/*
 * Footers that mean "a choice is waiting for you right now".
 *
 * A bare "esc to cancel" used to be in here, and it is the reason the island
 * announced input was needed while an agent was simply working: Claude Code
 * paints "Esc to cancel . Tab to amend . ctrl+e to explain" in its status area
 * for the whole duration of a turn. That made `hasActiveFooter` permanently
 * true, so any numbered list in an ordinary reply — and replies are full of
 * them — looked like a live choice prompt.
 *
 * Every alternative below has to be something a terminal only prints when it
 * is actually blocked on the user.
 */
const FOOTER_RE =
  /(press enter to confirm|enter to confirm or esc to cancel|enter to select|return to select|use (?:the )?(?:arrow keys|up\/down|↑|↓) to select|type here to tell|type your response|write your answer|choose an option|select an option)/i

const OPTION_RE = /^\s*[›>❯•]?\s*(?:\[(\d+)\]|(\d+)[.)])\s+(.+?)\s*$/
const QUESTION_RE = /\?\s*$/

function cleanLine(line: string): string {
  return line
    .replace(/[│┃]/g, '')
    .replace(/^[╭╮╯╰─\s]+|[╭╮╯╰─\s]+$/g, '')
    .replace(/^\s*[›>❯•]\s*/, '')
    .trim()
}

function classifyKind(text: string): TerminalInputKind {
  if (AUTH_RE.test(text)) return 'authentication'
  if (PLAN_RE.test(text)) return 'plan'
  if (/choose an option|select an option|enter to select|return to select/i.test(text)) return 'selection'
  if (/type here|type your response|write your answer|\?\s*$/i.test(text)) return 'question'
  return 'unsupported'
}

function titleFor(agentId: AgentId, kind: TerminalInputKind): string {
  const label = agentId === 'claude' ? 'Claude' : agentId === 'codex' ? 'Codex' : 'Hermes'
  switch (kind) {
    case 'plan':
      return `${label} has a plan ready`
    case 'selection':
      return `${label} needs a choice`
    case 'question':
      return `${label} needs your input`
    case 'authentication':
      return `${label} needs authentication`
    default:
      return `${label} needs input in the terminal`
  }
}

/**
 * Conservatively detects interactive prompts that should be completed in the
 * real managed terminal. It intentionally avoids known permission panels,
 * which have dedicated, safer adapters.
 */
export function detectTerminalInputPrompt(rawOutput: string, agentId: AgentId): TerminalInputDetection | null {
  const normalized = normalizeTerminalText(rawOutput)
  const tail = normalized.slice(-12_000)
  const trimmed = tail.trimEnd()
  if (!trimmed) return null

  const lines = trimmed.split(/\r?\n/).map(cleanLine).filter(Boolean)
  if (!lines.length) return null

  const recentLines = lines.slice(-48)
  const recentText = recentLines.join('\n')
  const footerIndex = recentText.search(FOOTER_RE)
  /*
   * Where a phrase appears matters, not merely that it appears.
   *
   * These were tested against the whole 48-line window, so a plan phrase in
   * ordinary prose plus an unrelated numbered list elsewhere on screen were
   * between them enough to raise a prompt. Quoting the wording sufficed: an
   * agent explaining "if it asks 'Would you like to proceed?'" while a menu
   * happened to be rendered below produced a card whose detail was a fragment
   * of that sentence. A real prompt states its question and renders its
   * choices together, so the phrase must sit in the same block as the thing
   * the user can act on. Resolved below, once `options` is known.
   */
  const lastLineMatching = (re: RegExp): number => {
    for (let index = recentLines.length - 1; index >= 0; index -= 1) {
      if (re.test(recentLines[index])) return index
    }
    return -1
  }
  const planLine = lastLineMatching(PLAN_RE)
  const authLine = lastLineMatching(AUTH_RE)

  const options = recentLines
    .map((line, index) => {
      const match = line.match(OPTION_RE)
      if (!match) return null
      const number = Number(match[1] ?? match[2])
      if (!Number.isFinite(number) || number < 1 || number > 99) return null
      return { index, number, label: match[3].trim() }
    })
    .filter((item): item is { index: number; number: number; label: string } => Boolean(item))

  let lastQuestionIndex = -1
  for (let index = recentLines.length - 1; index >= 0; index -= 1) {
    if (QUESTION_RE.test(recentLines[index])) {
      lastQuestionIndex = index
      break
    }
  }
  const hasTypedInputCue = /type here|type your response|write your answer|enter (?:the )?(?:code|token|password)/i.test(recentText)
  const hasActiveFooter = footerIndex >= 0 && recentText.length - footerIndex < 900

  /**
   * How far above the actionable part a prompt's own wording may sit.
   *
   * A panel puts its question immediately above its choices — one line, or two
   * across a blank. Prose that merely mentions the same words carries on for a
   * sentence or two first, which is the whole difference between the two.
   */
  const BLOCK_LINES = 2
  const firstOptionLine = options.length ? options[0].index : -1
  const nearActionable = (line: number): boolean => {
    if (line < 0) return false
    const gap = firstOptionLine - line
    if (firstOptionLine >= 0 && gap >= 0 && gap <= BLOCK_LINES) return true
    // A footer with no option list still anchors a prompt, but only when the
    // phrase sits in the tail of the window rather than back in scrollback.
    return hasActiveFooter && recentLines.length - line <= BLOCK_LINES * 2
  }
  const planMatch = nearActionable(planLine)
  const authMatch = nearActionable(authLine)
  // Known permission panels are handled by dedicated adapters. An older
  // permission panel in scrollback must not block a newer plan/auth prompt.
  if (EXPLICIT_APPROVAL_RE.test(recentText) && !planMatch && !authMatch && !hasTypedInputCue) return null
  const hasChoicePrompt = options.length >= 2 && (hasActiveFooter || planMatch)
  const hasQuestionPrompt = lastQuestionIndex >= 0 && hasTypedInputCue

  // A trailing question mark is NOT evidence of an interactive prompt. Agents
  // end ordinary replies with questions all the time ("Would you like me to
  // proceed?"), and PLAN_RE matches that same conversational phrasing — so
  // accepting `lastQuestionIndex >= 0` on its own made the island announce
  // "needs input" and echo the last line of a perfectly finished reply.
  //
  // Something the user can actually *act on* has to be on screen: a rendered
  // option list, or a key-hint footer ("Enter to confirm", "Esc to cancel"), or
  // an explicit request for typed input.
  const hasInteractiveAffordance = hasActiveFooter || options.length >= 2 || hasTypedInputCue
  const hasActivePlanPrompt = planMatch && hasInteractiveAffordance
  const hasActiveAuthPrompt = authMatch && hasInteractiveAffordance

  if (!hasActivePlanPrompt && !hasActiveAuthPrompt && !hasChoicePrompt && !hasQuestionPrompt) return null

  // Find the most useful line immediately before the choices/footer.
  const firstOptionIndex = options.length ? options[0].index : recentLines.length
  const promptSearchEnd = Math.min(firstOptionIndex, recentLines.length)
  let promptLine = ''
  for (let index = promptSearchEnd - 1; index >= 0; index -= 1) {
    const line = recentLines[index]
    if (!line || FOOTER_RE.test(line) || OPTION_RE.test(line)) continue
    if (QUESTION_RE.test(line) || PLAN_RE.test(line) || AUTH_RE.test(line)) {
      promptLine = line
      break
    }
  }

  if (!promptLine && lastQuestionIndex >= 0) promptLine = recentLines[lastQuestionIndex]
  if (!promptLine) {
    promptLine = planMatch
      ? 'A plan or workflow choice is waiting.'
      : authMatch
        ? 'Authentication must be completed in the terminal.'
        : 'This prompt has options that are safest to answer in the terminal.'
  }

  const optionSummary = options.slice(0, 4).map((option) => `${option.number}. ${option.label}`).join('\n')
  const detail = optionSummary ? `${promptLine}\n${optionSummary}` : promptLine
  const kind = classifyKind(`${promptLine}\n${recentText}`)
  const fingerprint = fingerprintDetection({
    command: `${agentId}:${kind}:${promptLine}`,
    choices: options.map((option) => `${option.number}:${option.label}`).join('|') || recentLines.slice(-6).join('|')
  })

  return {
    kind,
    title: titleFor(agentId, kind),
    detail,
    fingerprint
  }
}

export function createTerminalInputTrackerState(): TerminalInputTrackerState {
  return { pending: null, lastFingerprint: null, dismissedFingerprint: null }
}

export function updateTerminalInputTracker(input: {
  state: TerminalInputTrackerState
  chunkOrFullBuffer: string
  agentId: AgentId
  cwd: string
  processAlive: boolean
  suppress?: boolean
  now?: number
  makeId?: () => string
  ttlMs?: number
}): TerminalInputTrackerUpdate {
  const now = input.now ?? Date.now()
  const ttlMs = input.ttlMs ?? 10 * 60_000
  const next: TerminalInputTrackerState = { ...input.state }

  if (!input.processAlive || input.suppress) {
    if (next.pending) {
      const cleared = {
        ...next.pending,
        processAlive: input.processAlive,
        waitingForInput: false
      }
      next.pending = null
      if (!input.processAlive) {
        next.lastFingerprint = null
        next.dismissedFingerprint = null
      }
      return { state: next, cleared }
    }
    return { state: next }
  }

  const detection = detectTerminalInputPrompt(input.chunkOrFullBuffer, input.agentId)
  if (!detection) {
    if (next.pending) {
      const cleared = { ...next.pending, waitingForInput: false }
      next.pending = null
      next.lastFingerprint = null
      next.dismissedFingerprint = null
      return { state: next, cleared }
    }
    next.lastFingerprint = null
    next.dismissedFingerprint = null
    return { state: next }
  }

  if (next.dismissedFingerprint === detection.fingerprint) {
    next.lastFingerprint = detection.fingerprint
    return { state: next }
  }

  if (next.pending?.fingerprint === detection.fingerprint) {
    next.pending = { ...next.pending, processAlive: true, waitingForInput: true }
    next.lastFingerprint = detection.fingerprint
    return { state: next }
  }

  let cleared: TerminalInputPrompt | undefined
  if (next.pending) cleared = { ...next.pending, waitingForInput: false }

  const makeId = input.makeId ?? (() => `terminal-input-${input.agentId}-${now}-${Math.random().toString(36).slice(2, 8)}`)
  const raised: TerminalInputPrompt = {
    id: makeId(),
    agentId: input.agentId,
    kind: detection.kind,
    title: detection.title,
    detail: detection.detail,
    cwd: input.cwd,
    createdAt: now,
    expiresAt: now + ttlMs,
    processAlive: true,
    waitingForInput: true,
    fingerprint: detection.fingerprint
  }

  next.pending = raised
  next.lastFingerprint = detection.fingerprint
  next.dismissedFingerprint = null
  return { state: next, raised, cleared }
}

export function dismissTerminalInput(
  state: TerminalInputTrackerState,
  promptId?: string
): TerminalInputTrackerState {
  if (!state.pending || (promptId && state.pending.id !== promptId)) return state
  return {
    pending: null,
    lastFingerprint: state.pending.fingerprint,
    dismissedFingerprint: state.pending.fingerprint
  }
}
