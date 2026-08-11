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

/** A row exactly as Codex drew it, with the digit that selects it. */
export interface DetectedCodexOption {
  index: number
  label: string
  keys: string
}

export interface CodexApprovalDetection {
  kind: 'codex-command' | 'codex-file-change'
  title: string
  command: string
  description: string
  choices: DetectedCodexChoice[]
  /**
   * Every row, including ones no permission vocabulary describes. Codex's
   * cancel row is deliberately unclassified, so a card built from `choices`
   * alone would offer two ways to say yes and no way to refuse.
   */
  options: DetectedCodexOption[]
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

/**
 * Send the row's own digit, and nothing else.
 *
 * Verified against Codex 0.146.1 (CODEX_APPROVAL_UI_0.146.1.md, sourced to the
 * rust-v0.146.1 tag). Three separate reasons this is the only safe choice:
 *
 *  - Esc is NOT deny. It maps to Cancel -> ReviewDecision::Abort ->
 *    interrupt_task(), aborting the whole active turn. Sending it for an
 *    ordinary Deny killed the turn instead of refusing one command.
 *  - Letter shortcuts are user-configurable, so y/a/p/d/r cannot be assumed.
 *    A digit is positional and always selects the row Codex actually drew.
 *  - A digit submits immediately. Appending Enter meant it arrived after the
 *    overlay had closed and landed in the composer - the same bug fixed for
 *    Hermes in 4d54eae.
 */
function responseForChoice(index: number): string {
  return `${index}`
}

/**
 * Classify a row by what Codex actually means by it.
 *
 * Advisory only: the card renders every label verbatim and answers by digit,
 * so this decides just two things - which row needs the permanent-access
 * confirmation, and which row stays clickable when approving is unsafe. Both
 * are safety gates, so getting it wrong still matters.
 *
 * Order matters: session-scoped wording must be tested before the persistent
 * "ask again" wording, which would otherwise swallow it and promise a
 * permanent grant Codex never offered.
 */
function detectChoice(label: string): ApprovalDecision | null {
  /*
   * NOT a deny. This is Codex’s cancel action: it aborts the active turn.
   * Classifying it as deny mislabelled it in the UI and let it through the
   * deny-stays-clickable gate. Left unclassified so it renders verbatim and
   * carries no permission semantics.
   */
  if (/^No,\s*and tell Codex what to do differently/i.test(label)) return null
  // The genuine non-aborting refusals.
  if (/^No,\s*continue without/i.test(label)) return 'deny'
  if (/^No,\s*but continue without/i.test(label)) return 'deny'
  if (/^No,\s*and block this host/i.test(label)) return 'deny'

  // Session scope, deliberately ahead of the persistent patterns.
  if (/\bin this session\b/i.test(label)) return 'session'
  if (/\bfor this conversation\b/i.test(label)) return 'session'
  if (/\bfor this session\b/i.test(label)) return 'session'
  if (/^Yes,\s*and\s+don['’]t ask again for these files/i.test(label)) return 'session'

  // Persistent.
  if (/^Yes,\s*and\s+don['’]t ask again/i.test(label)) return 'always'
  if (/\bin the future\b/i.test(label)) return 'always'

  // One-off.
  if (/^Yes,\s*proceed/i.test(label)) return 'once'
  if (/^Yes,\s*just this once/i.test(label)) return 'once'
  if (/^Yes,\s*grant these permissions for this turn/i.test(label)) return 'once'
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
    responseKeys[key] = responseForChoice(candidate.index)
  }

  /*
   * An affirmative plus at least one other row.
   *
   * This used to require a classified `deny` as well. Codex's standard command
   * panel offers no such row — its only refusal is "No, and tell Codex what to
   * do differently", which is the cancel action and is deliberately left
   * unclassified. Demanding a deny therefore rejected every real panel.
   */
  if (!choices.some((choice) => choice.key === 'once')) return null
  if (rawChoices.length < 2) return null
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
    options: rawChoices.map((candidate) => ({
      index: candidate.index,
      label: candidate.label,
      keys: responseForChoice(candidate.index)
    })),
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
    // Every row Codex drew, so the unclassified cancel row still reaches the
    // card. Without it the user sees two ways to say yes and no way to refuse.
    options: detection.options,
    isPermission: true,
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
