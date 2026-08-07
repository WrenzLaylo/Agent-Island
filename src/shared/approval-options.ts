import type { ApprovalDecision, ApprovalRequest } from './contracts'

export interface ApprovalRow {
  /** The agent's own numbering, and literally what gets sent. */
  index: number
  /** The agent's own wording. */
  label: string
  /**
   * The classification, where one exists. Only two things depend on it: which
   * row needs the extra permanent-access confirmation, and whether the row is
   * gated behind the approve-safety check. It never decides what is displayed.
   */
  decision: ApprovalDecision | null
}

/**
 * Every option the terminal offered, in the terminal's own order.
 *
 * Rendering used to be driven by the classified decisions, which silently lost
 * two kinds of option: anything the classifier did not recognise ("Yes, but
 * let me edit the command first"), and any second option mapping to a slot
 * already taken. A four-option panel reached the island as three buttons with
 * no sign a choice was missing — and the missing one might be the one wanted.
 *
 * So the raw option list is the source of truth for what is shown and what is
 * sent. Classification is advisory, attached by index where it is known.
 */
export function approvalRows(approval: ApprovalRequest): ApprovalRow[] {
  const options = approval.options
  if (!options?.length) return []

  const decisionByIndex = new Map<number, ApprovalDecision>()
  for (const option of approval.choiceOptions ?? []) {
    decisionByIndex.set(option.index, option.decision)
  }

  return options
    .slice()
    .sort((left, right) => left.index - right.index)
    .map((option) => ({
      index: option.index,
      label: option.label,
      decision: decisionByIndex.get(option.index) ?? null
    }))
}

/**
 * Is this row a refusal?
 *
 * Denying stays available even when a request is no longer safe to approve, so
 * the user is never stuck with a card they cannot answer. Unclassified rows
 * count as approvals — treating a row as harmless because the classifier did
 * not recognise it would be exactly the wrong default.
 */
export function isDenyRow(row: { decision: ApprovalDecision | null }): boolean {
  return row.decision === 'deny'
}
