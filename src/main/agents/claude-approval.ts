import type { ApprovalDecision, ApprovalRequest, RiskLevel } from '../../shared/contracts'
import { normalizeTerminalText } from '../../shared/ansi'
import {
  classifyCommandRisk,
  createApprovalTrackerState,
  fingerprintDetection,
  type ApprovalTrackerState,
  type ApprovalTrackerUpdate
} from './hermes-approval'

export { createApprovalTrackerState }

/**
 * Claude Code's permission panel.
 *
 * Unlike Hermes and Codex, Claude does not print a fixed banner sentence. The
 * panel is identified by its *shape*: a "Do you want to …?" question followed
 * immediately by a numbered choice list containing both a bare "Yes" and a
 * "No". Requiring both poles is what keeps an ordinary numbered list in prose
 * from being mistaken for a permission request.
 *
 * Answering is by digit, which is what the panel's own numbering advertises —
 * deliberately not arrow keys, since the highlighted row depends on state we
 * cannot observe from the output stream alone.
 */

export interface DetectedClaudeChoice {
  index: number
  key: ApprovalDecision
  label: string
}

export interface ClaudeApprovalDetection {
  kind: 'claude-command' | 'claude-file-change' | 'claude-other'
  title: string
  command: string
  description: string
  choices: DetectedClaudeChoice[]
  fingerprint: string
  risk: RiskLevel
  riskReason: string
  responseKeys: Partial<Record<ApprovalDecision, string>>
}

/** "Do you want to proceed?" / "…make this edit to x.ts?" / "…create x.ts?" */
const QUESTION_RE = /^Do you want to\b.*\?$/i
const CHOICE_LINE_RE = /^\s*[❯›>*]?\s*(\d+)\.\s*(.+?)\s*$/
const YES_RE = /^Yes$/i
/** Session-scoped: "allow all edits during this session", "for this session". */
const YES_SESSION_RE = /^Yes,\s*(?:allow all\b.*\bsession|.*\bfor (?:the rest of )?this session)/i
/** Persistent: "don't ask again for X commands in <dir>". */
const YES_ALWAYS_RE = /^Yes,\s*and\s+don['’]t ask again/i
/*
 * The deny option is plain "No" in current Claude Code — captured live:
 *
 *   Do you want to proceed?
 *   1. Yes
 *   2. Yes, and don't ask again for: curl *
 *   3. No
 *
 * Older and other variants read "No, and tell Claude what to do differently",
 * so match any choice that starts with "No" rather than one exact sentence.
 */
const NO_RE = /^No\b/i

const EDIT_QUESTION_RE = /\b(edit|create|write|update|apply .*changes?) \b/i
const COMMAND_QUESTION_RE = /\bproceed\b|\brun\b/i

function cleanUiLine(line: string): string {
  return line
    .replace(/[│┃╎┆]/g, '')
    .replace(/^[╭╮╯╰─\s]+|[╭╮╯╰─\s]+$/g, '')
    .trim()
}

function classifyChoice(label: string): ApprovalDecision | null {
  if (NO_RE.test(label)) return 'deny'
  if (YES_ALWAYS_RE.test(label)) return 'always'
  if (YES_SESSION_RE.test(label)) return 'session'
  if (YES_RE.test(label)) return 'once'
  // "Yes, allow all …" variants that did not match the session phrasing are
  // still broader than a one-off, so treat them as session rather than once.
  if (/^Yes,\s*allow all/i.test(label)) return 'session'
  return null
}

export function detectClaudeApprovalPanel(rawOutput: string): ClaudeApprovalDetection | null {
  const text = normalizeTerminalText(rawOutput)
  const lines = text.split('\n').map(cleanUiLine)

  // Work backwards: only the newest panel is live, anything earlier is
  // scrollback from a request that has already been answered.
  let questionLine = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (QUESTION_RE.test(lines[i])) {
      questionLine = i
      break
    }
  }
  if (questionLine < 0) return null

  const rawChoices: Array<{ index: number; label: string; line: number }> = []
  for (let i = questionLine + 1; i < lines.length; i += 1) {
    const match = lines[i].match(CHOICE_LINE_RE)
    if (match) {
      const index = Number(match[1])
      if (!Number.isFinite(index) || index < 1 || index > 20) continue
      rawChoices.push({ index, label: match[2].trim(), line: i })
      continue
    }
    // Choice labels wrap; a non-empty, non-choice line directly after one is a
    // continuation. Stop at a blank line, which ends the panel.
    const current = rawChoices.at(-1)
    if (!lines[i]) {
      if (rawChoices.length) break
      continue
    }
    if (current) current.label = `${current.label} ${lines[i]}`.trim()
  }

  const choices: DetectedClaudeChoice[] = []
  const responseKeys: Partial<Record<ApprovalDecision, string>> = {}
  for (const candidate of rawChoices) {
    const key = classifyChoice(candidate.label)
    if (!key || responseKeys[key]) continue
    choices.push({ index: candidate.index, key, label: candidate.label })
    responseKeys[key] = `${candidate.index}`
  }

  // The panel is only recognised when both poles are present. A stray numbered
  // list in ordinary output cannot satisfy this.
  if (!choices.some((choice) => choice.key === 'once')) return null
  if (!choices.some((choice) => choice.key === 'deny')) return null

  const question = lines[questionLine]
  const body = lines.slice(Math.max(0, questionLine - 12), questionLine).filter(Boolean)

  const isEdit = EDIT_QUESTION_RE.test(question)
  const isCommand = !isEdit && COMMAND_QUESTION_RE.test(question)

  // The command or diff sits above the question, after the panel's own heading.
  const command = body.join('\n').trim() || question

  const baseRisk = classifyCommandRisk(command)
  const risk = isEdit
    ? { level: 'elevated' as const, reason: 'Claude is requesting approval to modify files' }
    : baseRisk

  const persistent = choices.find((choice) => choice.key === 'always')
  const riskReason = persistent
    ? `${risk.reason}. Permanent approval covers: ${persistent.label.replace(YES_ALWAYS_RE, '').trim() || 'matching commands'}`
    : risk.reason

  return {
    kind: isEdit ? 'claude-file-change' : isCommand ? 'claude-command' : 'claude-other',
    title: isEdit
      ? 'Claude wants to edit files'
      : isCommand
        ? 'Claude wants to run a command'
        : 'Claude needs permission',
    command,
    description: question,
    choices,
    fingerprint: fingerprintDetection({
      command,
      choices: choices.map((choice) => `${choice.index}:${choice.key}`).join(',')
    }),
    risk: risk.level,
    riskReason,
    responseKeys
  }
}

export function resolveClaudeResponseKeys(
  state: ApprovalTrackerState,
  decision: ApprovalDecision
): { ok: true; keys: string } | { ok: false; reason: string } {
  const keys = state.responseKeys?.[decision]
  if (!keys) {
    return { ok: false, reason: 'Claude did not offer that option for this request' }
  }
  return { ok: true, keys }
}

export function updateClaudeApprovalTracker(input: {
  state: ApprovalTrackerState
  chunkOrFullBuffer: string
  cwd: string
  processAlive: boolean
  now?: number
  makeId?: () => string
  ttlMs?: number
}): ApprovalTrackerUpdate {
  const now = input.now ?? Date.now()
  const ttlMs = input.ttlMs ?? 5 * 60_000
  const makeId = input.makeId ?? (() => `claude-${now}-${Math.random().toString(36).slice(2, 8)}`)
  const detection = detectClaudeApprovalPanel(input.chunkOrFullBuffer)

  const next: ApprovalTrackerState = {
    pending: input.state.pending,
    lastFingerprint: input.state.lastFingerprint,
    responseKeys: input.state.responseKeys
  }

  if (!detection) {
    if (next.pending) {
      const cleared: ApprovalRequest = {
        ...next.pending,
        waitingForInput: false,
        superseded: true,
        processAlive: input.processAlive
      }
      next.pending = null
      next.responseKeys = null
      return { state: next, cleared }
    }
    return { state: next }
  }

  if (next.pending && next.pending.fingerprint === detection.fingerprint) {
    return { state: next }
  }

  const cleared = next.pending
    ? { ...next.pending, waitingForInput: false, superseded: true, processAlive: input.processAlive }
    : undefined

  const raised: ApprovalRequest = {
    id: makeId(),
    agentId: 'claude',
    summary: detection.title,
    detail: detection.command,
    cwd: input.cwd,
    risk: detection.risk,
    riskReason: detection.riskReason,
    createdAt: now,
    expiresAt: now + ttlMs,
    processAlive: input.processAlive,
    waitingForInput: true,
    answered: false,
    superseded: false,
    source: 'claude-terminal',
    fingerprint: detection.fingerprint,
    choices: detection.choices.map((choice) => choice.key)
  }

  next.pending = raised
  next.lastFingerprint = detection.fingerprint
  next.responseKeys = detection.responseKeys
  return { state: next, raised, cleared }
}
