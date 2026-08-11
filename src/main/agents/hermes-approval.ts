import { createHash } from 'node:crypto'
import type {
  AgentId,
  ApprovalDecision,
  ApprovalRequest,
  RiskLevel
} from '../../shared/contracts'
import { normalizeTerminalText } from '../../shared/ansi'

export type HermesChoiceKey = 'once' | 'session' | 'always' | 'deny' | 'view'

export interface DetectedHermesChoice {
  index: number // 1-based as shown in UI
  key: HermesChoiceKey
  label: string
}

export interface HermesApprovalDetection {
  kind: 'hermes-dangerous-command'
  title: string
  command: string
  description: string
  choices: DetectedHermesChoice[]
  fingerprint: string
  risk: RiskLevel
  riskReason: string
  /** Keystrokes that select this choice (digit + Enter). */
  responseKeys: Partial<Record<ApprovalDecision, string>>
}

const TITLE_RE = /Dangerous Command/i

/**
 * Dangerous-command choices as Hermes Agent v0.19.1 renders them:
 *
 *   ❯ 1. Allow once
 *     2. Allow for this session
 *     4. Deny
 *
 * Dotted, not bracketed, and with no footer line. This detector previously
 * required `[1]` plus a `Type 1/2/3 or use` footer, so it returned null
 * against every real panel — three independent reasons to miss, which is why
 * Hermes approvals never reached the island at all.
 *
 * Bracketed `[N]` rows with that footer are a *different* panel: slash-command
 * confirmations. Requiring the dotted form keeps the two apart, on top of the
 * title check.
 */
const CHOICE_RE =
  /(?:^|\n)\s*[❯>]?\s*(\d+)\.\s*(Allow once|Allow for this session|Add to permanent allowlist|Deny|Show full command)\b/gi

const LABEL_TO_KEY: Record<string, HermesChoiceKey> = {
  'allow once': 'once',
  'allow for this session': 'session',
  'add to permanent allowlist': 'always',
  deny: 'deny',
  'show full command': 'view'
}

/**
 * Deterministic Hermes approval panel detector.
 * Requires the title and dotted numbered choices with labels Hermes actually
 * prints. No footer: v0.19.1 does not render one on this panel.
 * Does NOT match free-text that merely mentions "approve".
 */
export function detectHermesApprovalPanel(rawOutput: string): HermesApprovalDetection | null {
  const text = normalizeTerminalText(rawOutput)
  if (!TITLE_RE.test(text)) return null

  // Prefer the last panel occurrence (most recent prompt).
  const titleIdx = text.toLowerCase().lastIndexOf('dangerous command')
  if (titleIdx < 0) return null
  const window = text.slice(Math.max(0, titleIdx - 80), titleIdx + 4000)

  if (!TITLE_RE.test(window)) return null

  /*
   * Match against the panel with its box drawing removed.
   *
   * Every row arrives wrapped in box borders, so a line-anchored
   * pattern never sees the marker or the digit at the start of a line. The
   * previous pattern searched anywhere in the raw text, which worked only
   * because `[1]` is rare enough to be self-anchoring; a bare `1.` is not, and
   * would happily match prose. Stripping the borders first lets the pattern
   * stay anchored without being defeated by them.
   */
  const cleaned = window
    .split('\n')
    .map((line) => line.replace(/[│|]/g, ' ').trimEnd())
    .join('\n')

  const choices: DetectedHermesChoice[] = []
  const seenIndexes = new Set<number>()
  for (const match of cleaned.matchAll(CHOICE_RE)) {
    const index = Number(match[1])
    const label = match[2]
    const key = LABEL_TO_KEY[label.toLowerCase()]
    if (!key || !Number.isFinite(index) || index < 1 || index > 9) continue
    if (seenIndexes.has(index)) continue
    seenIndexes.add(index)
    choices.push({ index, key, label })
  }

  const hasOnce = choices.some((c) => c.key === 'once')
  const hasDeny = choices.some((c) => c.key === 'deny')
  if (!hasOnce || !hasDeny || choices.length < 2) {
    return null
  }

  // Command: lines between title line and first choice line.
  const lines = window.split('\n').map((l) => l.replace(/[│|]/g, '').trim())
  const titleLine = lines.findIndex((l) => /Dangerous Command/i.test(l))
  const firstChoiceLine = lines.findIndex((l) => /^[❯>]?\s*\d+\.\s*Allow once/i.test(l))
  if (titleLine < 0 || firstChoiceLine <= titleLine) {
    return null
  }

  const body = lines
    .slice(titleLine + 1, firstChoiceLine)
    .map((l) => l.replace(/^[╭╮╯╰─\s]+|[╭╮╯╰─\s]+$/g, '').trim())
    .filter((l) => l && !/^╰|^╭|^─+$/.test(l))

  // Hermes puts the command near the top of the body; description may follow.
  // Take non-empty body lines until we hit a clearly descriptive multi-word sentence
  // after we already captured a command-looking line.
  let command = ''
  const descParts: string[] = []
  for (const line of body) {
    if (!command) {
      // Skip pure box junk
      if (/^[╰╯╭╮─│\s]+$/.test(line)) continue
      command = line
      continue
    }
    descParts.push(line)
  }

  command = command.trim()
  if (!command || command.length < 1) {
    return null
  }

  // Guard: refuse if "command" is just another UI chrome line.
  if (/Type\s+1\/2\/3/i.test(command) || /^Allow once$/i.test(command)) {
    return null
  }

  const description = descParts.join(' ').trim()
  const responseKeys: HermesApprovalDetection['responseKeys'] = {}
  for (const choice of choices) {
    if (choice.key === 'view') continue
    // A bare digit submits immediately in Hermes' prompt-toolkit UI. The
    // trailing carriage return this used to send would arrive after the panel
    // had already closed, landing in the composer instead.
    responseKeys[choice.key] = `${choice.index}`
  }

  if (!responseKeys.once || !responseKeys.deny) {
    return null
  }

  const risk = classifyCommandRisk(command)
  const fingerprint = fingerprintDetection({
    command,
    choices: choices.map((c) => `${c.index}:${c.key}`).join(',')
  })

  return {
    kind: 'hermes-dangerous-command',
    title: 'Dangerous Command',
    command,
    description,
    choices,
    fingerprint,
    risk: risk.level,
    riskReason: risk.reason,
    responseKeys
  }
}

export function fingerprintDetection(parts: { command: string; choices: string }): string {
  return createHash('sha256')
    .update(parts.command)
    .update('\n')
    .update(parts.choices)
    .digest('hex')
    .slice(0, 24)
}

export function classifyCommandRisk(command: string): { level: RiskLevel; reason: string } {
  const c = command.toLowerCase()
  if (
    /rm\s+-rf|remove-item\s+.*-recurse|del\s+\/s|format\s+|diskpart|drop\s+table|mkfs|dd\s+if=/.test(
      c
    )
  ) {
    return { level: 'high', reason: 'Destructive / irreversible filesystem or disk operation' }
  }
  if (/git\s+push\s+.*--force|git\s+reset\s+--hard|git\s+clean\s+-fd/.test(c)) {
    return { level: 'high', reason: 'Destructive git history rewrite' }
  }
  if (/npm\s+publish|pip\s+upload|twine\s+upload|docker\s+push/.test(c)) {
    return { level: 'elevated', reason: 'Publishes artifacts externally' }
  }
  if (/curl\s+.*\|\s*(ba)?sh|wget\s+.*\|\s*(ba)?sh|invoke-expression|iex\s*\(/.test(c)) {
    return { level: 'high', reason: 'Remote code execution pattern' }
  }
  if (/npm\s+i|npm\s+install|pnpm\s+add|yarn\s+add|pip\s+install/.test(c)) {
    return { level: 'elevated', reason: 'Installs packages from the network' }
  }
  if (/git\s+push/.test(c)) {
    return { level: 'elevated', reason: 'Pushes to remote repository' }
  }
  // classifyCommandRisk is shared by the Hermes, Codex and Claude adapters, so
  // this wording must not name one of them.
  return { level: 'low', reason: 'The agent asked for confirmation before running this' }
}

export interface ApprovalTrackerState {
  pending: ApprovalRequest | null
  /** Last fingerprint we successfully detected as still on-screen. */
  lastFingerprint: string | null
  /** Keystrokes for the pending request. */
  responseKeys: HermesApprovalDetection['responseKeys'] | null
}

export function createApprovalTrackerState(): ApprovalTrackerState {
  return { pending: null, lastFingerprint: null, responseKeys: null }
}

export interface ApprovalTrackerUpdate {
  state: ApprovalTrackerState
  /** Newly raised request (only when fingerprint changes). */
  raised?: ApprovalRequest
  /** Cleared because panel left the screen. */
  cleared?: ApprovalRequest
}

/**
 * Feed cleaned/raw terminal chunks. Returns raise/clear events.
 * Pure-ish: caller supplies now + id factory.
 */
export function updateHermesApprovalTracker(input: {
  state: ApprovalTrackerState
  chunkOrFullBuffer: string
  agentId: AgentId
  cwd: string
  processAlive: boolean
  now?: number
  makeId?: () => string
  ttlMs?: number
}): ApprovalTrackerUpdate {
  const now = input.now ?? Date.now()
  const ttlMs = input.ttlMs ?? 5 * 60_000
  const makeId =
    input.makeId ??
    (() => `hermes-${now}-${Math.random().toString(36).slice(2, 8)}`)

  const detection = detectHermesApprovalPanel(input.chunkOrFullBuffer)
  const next: ApprovalTrackerState = {
    pending: input.state.pending,
    lastFingerprint: input.state.lastFingerprint,
    responseKeys: input.state.responseKeys
  }

  if (!input.processAlive) {
    if (next.pending && !next.pending.answered) {
      const cleared = {
        ...next.pending,
        processAlive: false,
        waitingForInput: false,
        superseded: true
      }
      next.pending = null
      next.lastFingerprint = null
      next.responseKeys = null
      return { state: next, cleared }
    }
    return { state: next }
  }

  if (!detection) {
    // Panel gone — if we had a pending unanswered request, mark cleared/superseded.
    if (next.pending && !next.pending.answered && next.pending.waitingForInput) {
      const cleared = {
        ...next.pending,
        waitingForInput: false,
        superseded: true
      }
      next.pending = null
      next.lastFingerprint = null
      next.responseKeys = null
      return { state: next, cleared }
    }
    return { state: next }
  }

  // Panel present
  if (next.pending && next.pending.fingerprint === detection.fingerprint && !next.pending.answered) {
    // Refresh liveness flags only
    next.pending = {
      ...next.pending,
      processAlive: true,
      waitingForInput: true
    }
    next.responseKeys = detection.responseKeys
    next.lastFingerprint = detection.fingerprint
    return { state: next }
  }

  // New or changed panel — supersede old
  let cleared: ApprovalRequest | undefined
  if (next.pending && !next.pending.answered) {
    cleared = {
      ...next.pending,
      waitingForInput: false,
      superseded: true
    }
  }

  const raised: ApprovalRequest = {
    id: makeId(),
    agentId: input.agentId,
    summary: detection.title,
    detail: detection.command,
    cwd: input.cwd,
    risk: detection.risk,
    riskReason: detection.riskReason || detection.description || undefined,
    createdAt: now,
    expiresAt: now + ttlMs,
    processAlive: true,
    waitingForInput: true,
    answered: false,
    superseded: false,
    source: 'hermes-terminal',
    fingerprint: detection.fingerprint,
    choices: detection.choices
      .filter((choice): choice is DetectedHermesChoice & { key: ApprovalDecision } => choice.key !== 'view')
      .map((choice) => choice.key),
    choiceOptions: detection.choices
      .filter((choice): choice is DetectedHermesChoice & { key: ApprovalDecision } => choice.key !== 'view')
      .map((choice) => ({ decision: choice.key, index: choice.index, label: choice.label }))
  }

  next.pending = raised
  next.lastFingerprint = detection.fingerprint
  next.responseKeys = detection.responseKeys
  return { state: next, raised, cleared }
}

export function resolveHermesResponseKeys(
  state: ApprovalTrackerState,
  decision: ApprovalDecision
): { ok: true; keys: string } | { ok: false; reason: string } {
  if (!state.pending || !state.responseKeys) {
    return { ok: false, reason: 'No pending Hermes approval' }
  }
  const keys = state.responseKeys[decision]
  if (!keys) {
    const labels: Record<ApprovalDecision, string> = {
      once: 'Allow once',
      session: 'Allow for this session',
      always: 'Add to permanent allowlist',
      deny: 'Deny'
    }
    return { ok: false, reason: `${labels[decision]} option not available` }
  }
  return { ok: true, keys }
}
