import { motion } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import { APPROVAL_REARM_MS, approvalReArmed } from '@shared/approval-guard'
import type { ApprovalRequest } from '@shared/contracts'

interface ChoiceCardProps {
  prompt: ApprovalRequest
  disabled?: boolean
  onOption: (index: number) => void
  onText: (text: string) => void
  onOpenTerminal: () => void
}

/**
 * A numbered question the agent asked — plan mode, or anything else with a
 * list of answers.
 *
 * Every label is shown exactly as the agent wrote it. Nothing here is
 * translated into approve/deny language, because these options carry no such
 * meaning: "Yes, and auto-accept edits" is not a permission grant, and calling
 * it one would misrepresent what the user is agreeing to.
 *
 * The text field exists because a list is not always the whole answer — Claude
 * routinely offers options *and* accepts free input. Typing here sends the
 * text followed by Enter, exactly as if it had been typed in the terminal.
 */
export function ChoiceCard({ prompt, disabled = false, onOption, onText, onOpenTerminal }: ChoiceCardProps) {
  const options = useMemo(() => prompt.options ?? [], [prompt.options])
  const [draft, setDraft] = useState('')

  // Same hazard as the approval card: a queued prompt can replace this one
  // under a resting cursor. See APPROVAL_REARM_MS.
  const [armed, setArmed] = useState(false)
  const shownAtRef = useRef(0)
  useEffect(() => {
    shownAtRef.current = Date.now()
    setArmed(false)
    setDraft('')
    const timer = window.setTimeout(() => setArmed(true), APPROVAL_REARM_MS)
    return () => window.clearTimeout(timer)
  }, [prompt.id])

  const inert = disabled || !armed

  const chooseOption = (index: number) => {
    if (!approvalReArmed(shownAtRef.current, Date.now())) return
    onOption(index)
  }

  const submitText = () => {
    const text = draft.trim()
    if (!text) return
    // Typing takes time, so the re-arm window has long since passed; the guard
    // here is against a submit racing the card being replaced.
    if (!approvalReArmed(shownAtRef.current, Date.now())) return
    onText(text)
    setDraft('')
  }

  return (
    <div className="choice-card">
      <p className="choice-question">{prompt.summary}</p>
      {prompt.detail && prompt.detail !== prompt.summary ? (
        <pre className="choice-detail">{prompt.detail}</pre>
      ) : null}

      <div className="choice-list">
        {options.map((option) => (
          <motion.button
            key={option.index}
            type="button"
            className="choice-button"
            data-no-drag="true"
            onClick={() => chooseOption(option.index)}
            disabled={inert}
            whileTap={!inert ? { scale: 0.985 } : undefined}
          >
            <span className="choice-index">{option.index}</span>
            <span className="choice-label">{option.label}</span>
          </motion.button>
        ))}
      </div>

      <div className="choice-compose">
        <input
          type="text"
          className="choice-input"
          data-no-drag="true"
          placeholder="or type a reply…"
          value={draft}
          disabled={inert}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            submitText()
          }}
          aria-label="Type a reply to send to the agent"
        />
        <button
          type="button"
          className="choice-send"
          data-no-drag="true"
          onClick={submitText}
          disabled={inert || draft.trim().length === 0}
        >
          Send
        </button>
      </div>

      {/* Demoted to a link: the island can answer this, so switching to the
          terminal is the fallback, not the headline action. */}
      <button type="button" className="choice-terminal-link" data-no-drag="true" onClick={onOpenTerminal}>
        Answer in the terminal instead
      </button>
    </div>
  )
}
