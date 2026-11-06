import { motion } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import { APPROVAL_REARM_MS, approvalReArmed } from '@shared/approval-guard'
import { isTypingTarget, rowForKey, rowKey } from '@shared/approval-keys'
import { approvalRows, isDenyRow } from '@shared/approval-options'
import {
  AGENT_LABELS,
  type ApprovalDecision,
  type ApprovalRequest,
  type DecisionOption
} from '@shared/contracts'

interface ApprovalCardProps {
  reducedMotion?: boolean
  /** Shared with the confirmation, so the chosen row carries on into it. */
  landingId?: string
  approval: ApprovalRequest
  approveEnabled: boolean
  disabled?: boolean
  onDecision: (decision: ApprovalDecision) => void
  /** Answer by the agent's own digit; `decision` is advisory context only. */
  onOption: (index: number, decision: ApprovalDecision | null) => void
}

/**
 * How long the agent has been blocked.
 *
 * With a queue, this is the strongest signal for which decision to make
 * first, and the card showed nothing — a request three seconds old and one
 * that had stalled an agent for four minutes were indistinguishable.
 */
function useElapsed(since: number): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [since])
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function riskLabel(risk: ApprovalRequest['risk']): string {
  switch (risk) {
    case 'high':
      return 'High risk'
    case 'elevated':
      return 'Elevated risk'
    case 'low':
      return 'Low risk'
    default:
      return 'Review carefully'
  }
}

function shortenCommand(command: string, max = 1200): string {
  const trimmed = command.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

const CHOICE_ORDER: ApprovalDecision[] = ['once', 'session', 'always', 'deny']

/**
 * Wording follows the agent that raised the request. It used to key off
 * `source === 'codex-terminal'`, which meant every non-Hermes agent — Claude
 * included — was described to the user as Codex.
 */
function agentLabel(approval: ApprovalRequest): string {
  return AGENT_LABELS[approval.agentId]
}

/** Agents that persist a command-prefix rule rather than a literal allowlist. */
function persistsPrefixRule(approval: ApprovalRequest): boolean {
  return approval.agentId === 'codex' || approval.agentId === 'claude'
}

function choiceLabel(choice: ApprovalDecision, approval: ApprovalRequest): string {
  switch (choice) {
    case 'session':
      return 'Allow for this session'
    case 'always':
      return persistsPrefixRule(approval) ? "Don't ask again" : 'Add to permanent allowlist'
    case 'deny':
      return 'Deny'
    default:
      return 'Allow once'
  }
}

function choiceHint(choice: ApprovalDecision, approval: ApprovalRequest): string {
  switch (choice) {
    case 'session':
      return 'Remember until this agent session ends'
    case 'always':
      return persistsPrefixRule(approval)
        ? `${agentLabel(approval)} may persist a matching command-prefix rule across future sessions`
        : 'Automatically allow matching commands in future sessions'
    case 'deny':
      return 'Block this action and return control to the agent'
    default:
      return 'Run this action one time only'
  }
}

function DecisionIcon({ choice }: { choice: ApprovalDecision }) {
  if (choice === 'deny') return <span aria-hidden="true">×</span>
  if (choice === 'session') return <span aria-hidden="true">◷</span>
  if (choice === 'always') return <span aria-hidden="true">◇</span>
  return <span aria-hidden="true">✓</span>
}

export function ApprovalCard({
  reducedMotion = false,
  landingId,
  approval,
  approveEnabled,
  disabled = false,
  onDecision,
  onOption
}: ApprovalCardProps) {
  const [pendingPermanent, setPendingPermanent] = useState<{ index: number | null; decision: ApprovalDecision | null } | null>(null)
  /*
   * Prefer the agent's own wording and ordering. The fallback list exists for
   * requests that carry no captured labels — the Hermes IPC bridge, and any
   * wrapper older than this build — where inventing a phrase is the only
   * option left.
   */
  const offered = useMemo(() => approvalRows(approval), [approval])
  const choices = useMemo(
    () => CHOICE_ORDER.filter((choice) => (approval.choices?.length ? approval.choices : ['once', 'deny']).includes(choice)),
    [approval.choices]
  )
  const rows = useMemo(
    () =>
      offered.length
        ? offered.map((row) => ({ ...row, hint: '' }))
        : choices.map((choice) => ({
            decision: choice as ApprovalDecision | null,
            index: null as number | null,
            label: choiceLabel(choice, approval),
            hint: choiceHint(choice, approval)
          })),
    [offered, choices, approval]
  )

  useEffect(() => setPendingPermanent(null), [approval.id])

  /**
   * Answering one approval promotes the next queued one into this same card,
   * so the buttons stay inert briefly whenever the request id changes. Without
   * it, the second half of an accidental double-click answers a request the
   * user has not read yet — see APPROVAL_REARM_MS.
   */
  const [armed, setArmed] = useState(false)
  const shownAtRef = useRef(0)
  useEffect(() => {
    shownAtRef.current = Date.now()
    setArmed(false)
    const timer = window.setTimeout(() => setArmed(true), APPROVAL_REARM_MS)
    return () => window.clearTimeout(timer)
  }, [approval.id])

  // Set the moment an answer is sent, so a second click cannot follow it and
  // the row can carry on into the confirmation.
  const [chosen, setChosen] = useState<string | null>(null)
  const inert = disabled || !armed || chosen !== null
  const elapsed = useElapsed(approval.createdAt)

  /**
   * `index` is present whenever the agent's own option list reached us, and is
   * then the thing that gets sent — the classification is not consulted. The
   * decision-only path is the fallback for requests carrying no option list.
   */
  const choose = (row: { index: number | null; decision: ApprovalDecision | null }) => {
    // The disabled attribute already covers pointer clicks; this also refuses
    // keyboard activation and anything that replays an event into the card.
    if (!approvalReArmed(shownAtRef.current, Date.now())) return
    if (row.decision === 'always') {
      setPendingPermanent(row)
      return
    }
    setChosen(`${row.decision}-${row.index ?? 'x'}`)
    if (row.index != null) onOption(row.index, row.decision)
    else if (row.decision) onDecision(row.decision)
  }

  // One answer per card from the keyboard, however fast the second key lands.
  const keyedRef = useRef<string | null>(null)

  // Reattached each render on purpose: it reads the same props the buttons do.
  useEffect(() => {
    if (pendingPermanent) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      const row = rowForKey(rows, event)
      if (!row || inert || (!isDenyRow(row) && !approveEnabled)) return
      if (keyedRef.current === approval.id) return
      event.preventDefault()
      // An "always" row only opens its confirmation, so it answers nothing yet.
      if (row.decision !== 'always') keyedRef.current = approval.id
      choose(row)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <div className={`approval-card risk-${approval.risk}`}>
      {/* The panel header already states "Approval required" and names the
          agent, so this row carries only the request-specific summary and the
          risk verdict. */}
      <div className="approval-summary-row">
        <span className="approval-summary-copy">{approval.summary || 'Command approval'}</span>
        <span className="approval-elapsed" title="How long the agent has been waiting">
          {elapsed}
        </span>
      </div>

      {/* The command is the decision. Everything else on this card is context
          for it, so it gets the type scale and the risk carries in its own
          rule rather than in a badge elsewhere. */}
      <div className={`command-block risk-${approval.risk}`}>
        <pre title={approval.detail}>{shortenCommand(approval.detail)}</pre>
        <p className="command-risk">
          <span className="command-risk-level">{riskLabel(approval.risk)}</span>
          {approval.riskReason ? <span className="command-risk-reason">{approval.riskReason}</span> : null}
        </p>
      </div>

      <div className="approval-context">
        {approval.cwd ? (
          <div><span>Folder</span><code>{approval.cwd}</code></div>
        ) : null}
      </div>

      {!approveEnabled ? (
        <div className="stale-warning" role="status">
          This request is no longer safe to approve. Deny it or reopen the action from the agent.
        </div>
      ) : null}

      {pendingPermanent ? (
        <motion.div
          className="permanent-confirmation"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div>
            <strong>{persistsPrefixRule(approval) ? `Stop asking for matching ${agentLabel(approval)} commands?` : 'Allow matching commands automatically?'}</strong>
            <small>{persistsPrefixRule(approval)
              ? `${agentLabel(approval)} may save a broad command-prefix rule that remains active in future sessions and workspaces. Confirm only when you understand the displayed scope.`
              : 'This permission can apply in future sessions. Only confirm when you trust this command pattern.'}</small>
          </div>
          <div className="permanent-actions">
            <button type="button" className="quiet-button" data-no-drag="true" onClick={() => setPendingPermanent(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="permanent-button"
              data-no-drag="true"
              disabled={!approveEnabled || inert}
              onClick={() =>
                pendingPermanent.index != null
                  ? onOption(pendingPermanent.index, 'always')
                  : onDecision('always')
              }
            >
              Confirm permanent access
            </button>
          </div>
        </motion.div>
      ) : (
        <div className={`decision-list choices-${rows.length}`}>
          {rows.map((row, position) => {
            // Unclassified rows are gated like approvals, never like denials.
            const isDeny = isDenyRow(row)
            const buttonDisabled = inert || (!isDeny && !approveEnabled)
            const rowId = `${row.decision}-${row.index ?? 'x'}`
            return (
              <motion.button
                key={rowId}
                type="button"
                className={`decision-button decision-${row.decision ?? 'other'} ${chosen === rowId ? 'is-chosen' : ''}`}
                layoutId={chosen === rowId && !reducedMotion ? landingId : undefined}
                data-no-drag="true"
                onClick={() => choose(row)}
                disabled={buttonDisabled}
                aria-keyshortcuts={String(rowKey(row, position))}
                whileTap={!buttonDisabled ? { scale: 0.985 } : undefined}
              >
                {/* The digit is shown because it is literally what gets sent to
                    the terminal, so the row is checkable against the panel. */}
                {row.index != null ? (
                  <span className="decision-index">{row.index}</span>
                ) : (
                  <span className="decision-icon"><DecisionIcon choice={row.decision ?? 'once'} /></span>
                )}
                <span className="decision-copy">
                  <strong>{row.label}</strong>
                  {row.hint ? <small>{row.hint}</small> : null}
                </span>
                {row.index == null ? (
                  <kbd className="decision-key" aria-hidden="true">{rowKey(row, position)}</kbd>
                ) : null}
              </motion.button>
            )
          })}
        </div>
      )}
    </div>
  )
}
