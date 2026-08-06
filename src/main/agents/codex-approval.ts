import type { ApprovalDecision, ApprovalRequest, RiskLevel } from '../../shared/contracts'
import { normalizeTerminalText } from '../../shared/ansi'
import {
  classifyCommandRisk,
  fingerprintDetection,
  type ApprovalTrackerState,
  type ApprovalTrackerUpdate
} from './hermes-approval'

export interface DetectedCodexChoice {
  index: number
  key: ApprovalDecision
  label: string
}

export interface CodexApprovalDetection {
  kind: 'codex-command' | 'codex-file-change'
  title: string
  command: string
  description: string
  choices: DetectedCodexChoice[]
  fingerprint: string
  risk: RiskLevel
  riskReason: string
  responseKeys: Partial<Record<ApprovalDecision, string>>
}

const RUN_TITLE_RE = /Would you like to run the following command\?/i
const EDIT_TITLE_RE = /Would you like to make the following edits\?/i
const CURRENT_PROMPT_RE = /Press enter to confirm or esc to cancel/i
const CHOICE_LINE_RE = /^\s*[›>]?\s*(\d+)\.\s*(.+?)\s*$/i

function cleanUiLine(line: string): string {
  return line
    .replace(/[│┃]/g, '')
    .replace(/^\s*[›>•]\s*/, '')
    .replace(/^[╭╮╯╰─\s]+|[╭╮╯╰─\s]+$/g, '')
    .trim()
}

function responseForChoice(key: ApprovalDecision, label: string, index: number): string {
  if (key === 'deny') return '\u001b'
  if (key === 'always' && /\(p\)/i.test(label)) return 'p'
  if (key === 'once' && /\(y\)/i.test(label)) return 'y'
  if (key === 'once' && index === 1) return '\r'
  // Fallback for older Codex builds whose prompt is arrow-driven but numbered.
  return `${index}\r`
}

function detectChoice(label: string): ApprovalDecision | null {
  if (/^Yes,\s*proceed/i.test(label)) return 'once'
  if (/^Yes,\s*and\s+don['’]t ask again/i.test(label)) return 'always'
  if (/^No,\s*and tell Codex what to do differently/i.test(label)) return 'deny'
  return null
}

/**
 * Detect the current Codex TUI command/file approval panel.
 *
 * This intentionally matches Codex's explicit approval copy and requires the
 * active prompt footer near the end of the terminal buffer. That avoids
 * treating old approval text in scrollback as a live request.
 */
export function detectCodexApprovalPanel(rawOutput: string): CodexApprovalDetection | null {
  const text = normalizeTerminalText(rawOutput)
  const runIndex = text.search(RUN_TITLE_RE)
  const editIndex = text.search(EDIT_TITLE_RE)
  if (runIndex < 0 && editIndex < 0) return null

  const lastRun = text.toLowerCase().lastIndexOf('would you like to run the following command?')
  const lastEdit = text.toLowerCase().lastIndexOf('would you like to make the following edits?')
  const titleIndex = Math.max(lastRun, lastEdit)
  if (titleIndex < 0) return null

  const window = text.slice(titleIndex, titleIndex + 8000)
  const trimmed = window.trimEnd()
  const footerMatch = [...trimmed.matchAll(new RegExp(CURRENT_PROMPT_RE.source, 'gi'))].at(-1)
  if (!footerMatch) return null
  // The footer must still be at the live end of the TUI, not buried in scrollback.
  if (trimmed.length - ((footerMatch.index ?? 0) + footerMatch[0].length) > 280) return null

  const isEdit = EDIT_TITLE_RE.test(window.split('\n')[0] ?? '')
  const lines = window.split('\n').map(cleanUiLine)
  const titleLine = lines.findIndex((line) => (isEdit ? EDIT_TITLE_RE : RUN_TITLE_RE).test(line))
  if (titleLine < 0) return null

  const choices: DetectedCodexChoice[] = []
  const responseKeys: Partial<Record<ApprovalDecision, string>> = {}
  let firstChoiceLine = -1
  const rawChoices: Array<{ index: number; label: string; line: number }> = []

  for (let i = titleLine + 1; i < lines.length; i += 1) {
    const match = lines[i].match(CHOICE_LINE_RE)
    if (match) {
      const index = Number(match[1])
      if (!Number.isFinite(index)) continue
      rawChoices.push({ index, label: match[2].trim(), line: i })
      continue
    }
    const current = rawChoices.at(-1)
    if (
      current &&
      lines[i] &&
      !CURRENT_PROMPT_RE.test(lines[i]) &&
      !RUN_TITLE_RE.test(lines[i]) &&
      !EDIT_TITLE_RE.test(lines[i])
    ) {
      current.label = `${current.label} ${lines[i]}`.trim()
    }
  }

  for (const candidate of rawChoices) {
    const key = detectChoice(candidate.label)
    if (!key) continue
    if (firstChoiceLine < 0) firstChoiceLine = candidate.line
    choices.push({ index: candidate.index, key, label: candidate.label })
    responseKeys[key] = responseForChoice(key, candidate.label, candidate.index)
  }

  if (!choices.some((choice) => choice.key === 'once') || !choices.some((choice) => choice.key === 'deny')) {
    return null
  }
  if (firstChoiceLine <= titleLine) return null

  const body = lines.slice(titleLine + 1, firstChoiceLine).filter(Boolean)
  const reasonLine = body.find((line) => /^Reason:/i.test(line))
  const reason = reasonLine?.replace(/^Reason:\s*/i, '').trim() ?? ''

  let command = ''
  if (isEdit) {
    command = body
      .filter((line) => !/^Reason:/i.test(line))
      .join('\n')
      .trim()
  } else {
    const dollarIndex = body.findIndex((line) => /^\$\s*/.test(line))
    if (dollarIndex >= 0) {
      command = body
        .slice(dollarIndex)
        .map((line, index) => (index === 0 ? line.replace(/^\$\s*/, '') : line))
        .join('\n')
        .trim()
    } else {
      command = body
        .filter((line) => !/^Reason:/i.test(line))
        .join('\n')
        .trim()
    }
  }

  if (!command) return null

  const baseRisk = classifyCommandRisk(command)
  const networkRequest = /network|internet|outside the sandbox/i.test(reason) || /(^|\s)(curl|wget|Invoke-WebRequest|irm)(\s|$)/i.test(command)
  const risk = isEdit
    ? { level: 'elevated' as const, reason: reason || 'Codex is requesting approval to modify files' }
    : networkRequest && baseRisk.level === 'low'
      ? { level: 'elevated' as const, reason: reason || 'Command requests network access' }
      : baseRisk
  const persistentChoice = choices.find((choice) => choice.key === 'always')
  const persistentScope = persistentChoice?.label.match(/start with\s+[`“"]?(.+?)[`”"]?(?:\s*\(p\))?$/i)?.[1]
  const riskReason = reason || (persistentScope
    ? `${risk.reason}. Permanent approval may cover commands starting with: ${persistentScope}`
    : risk.reason)

  const fingerprint = fingerprintDetection({
    command,
    choices: choices.map((choice) => `${choice.index}:${choice.key}:${choice.label}`).join(',')
  })

  return {
    kind: isEdit ? 'codex-file-change' : 'codex-command',
    title: isEdit ? 'Codex wants to edit files' : 'Codex wants to run a command',
    command,
    description: reason,
    choices,
    fingerprint,
    risk: risk.level,
    riskReason,
    responseKeys
  }
}

export function updateCodexApprovalTracker(input: {
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
  const makeId = input.makeId ?? (() => `codex-${now}-${Math.random().toString(36).slice(2, 8)}`)
  const detection = detectCodexApprovalPanel(input.chunkOrFullBuffer)
  const next: ApprovalTrackerState = {
    pending: input.state.pending,
    lastFingerprint: input.state.lastFingerprint,
    responseKeys: input.state.responseKeys
  }

  if (!input.processAlive) {
    if (next.pending && !next.pending.answered) {
      const cleared = { ...next.pending, processAlive: false, waitingForInput: false, superseded: true }
      return { state: { pending: null, lastFingerprint: null, responseKeys: null }, cleared }
    }
    return { state: next }
  }

  if (!detection) {
    if (next.pending && !next.pending.answered && next.pending.waitingForInput) {
      const cleared = { ...next.pending, waitingForInput: false, superseded: true }
      return { state: { pending: null, lastFingerprint: null, responseKeys: null }, cleared }
    }
    return { state: next }
  }

  if (next.pending && next.pending.fingerprint === detection.fingerprint && !next.pending.answered) {
    next.pending = { ...next.pending, processAlive: true, waitingForInput: true }
    next.responseKeys = detection.responseKeys
    next.lastFingerprint = detection.fingerprint
    return { state: next }
  }

  let cleared: ApprovalRequest | undefined
  if (next.pending && !next.pending.answered) {
    cleared = { ...next.pending, waitingForInput: false, superseded: true }
  }

  const raised: ApprovalRequest = {
    id: makeId(),
    agentId: 'codex',
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
    source: 'codex-terminal',
    fingerprint: detection.fingerprint,
    choices: detection.choices.map((choice) => choice.key),
    choiceOptions: detection.choices.map((choice) => ({
      decision: choice.key,
      index: choice.index,
      label: choice.label
    }))
  }

  next.pending = raised
  next.lastFingerprint = detection.fingerprint
  next.responseKeys = detection.responseKeys
  return { state: next, raised, cleared }
}

export function resolveCodexResponseKeys(
  state: ApprovalTrackerState,
  decision: ApprovalDecision
): { ok: true; keys: string } | { ok: false; reason: string } {
  if (!state.pending || !state.responseKeys) {
    return { ok: false, reason: 'No pending Codex approval' }
  }
  const keys = state.responseKeys[decision]
  if (!keys) return { ok: false, reason: 'That approval option is not available in this Codex prompt' }
  return { ok: true, keys }
}
