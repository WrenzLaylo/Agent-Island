import type { ApprovalRequest, DecisionOption } from './contracts'

/**
 * What the terminal actually offered, in the terminal's own order.
 *
 * The island used to substitute its own phrases: "Allow permanently" where
 * Claude had written "Yes, and don't ask again for: curl *". The paraphrase
 * lost the scope, which is the only part that made the decision safe to make —
 * two permanent grants with very different reach read identically.
 *
 * Ordering is by the agent's numbering rather than by decision severity, so
 * the row you press is the row you would have pressed in the terminal.
 */
export function verbatimOptions(approval: ApprovalRequest): DecisionOption[] {
  const offered = approval.choiceOptions
  if (!offered?.length) return []
  const allowed = new Set(approval.choices ?? offered.map((option) => option.decision))
  return offered
    .filter((option) => allowed.has(option.decision))
    .slice()
    .sort((left, right) => left.index - right.index)
}

