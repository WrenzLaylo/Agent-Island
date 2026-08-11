/**
 * Last-resort signal that a terminal is blocked on something nobody parsed.
 *
 * The adapters recognise specific panels and `terminal-input` recognises
 * specific wording. When both miss — a new agent version, an unfamiliar
 * prompt, a localised build — the result is the worst possible outcome: the
 * agent sits waiting and the island stays perfectly calm. Silence is the one
 * failure the user cannot notice.
 *
 * This deliberately reads nothing. No titles, no labels, no key hints — every
 * one of those is what the other detectors already tried and what breaks when
 * an agent changes its copy. It looks only at shape.
 */

/**
 * A numbered row carrying a selection marker.
 *
 * The marker is the whole discriminator. A numbered list in prose — "I made
 * three changes: 1. ... 2. ..." — is extremely common in agent output and goes
 * quiet exactly like a prompt does, so a bare numbered list cannot mean
 * anything. Agents draw a marker beside the highlighted row only when a picker
 * is genuinely open and waiting.
 *
 * Only the two markers real agents draw: Claude and Hermes use U+276F, Codex
 * uses U+203A. `>` and `*` are deliberately excluded even though the real
 * adapters accept them — "> 1. Quoted item" and "* 1. Bulleted" are ordinary
 * markdown, which agents emit constantly, and this detector has no title or
 * wording to disqualify them afterwards.
 */
const MARKED_ROW_RE = /^\s*[❯›]\s*(?:\[\d+\]|\d+[.)])\s+\S/
/** Any numbered row, marked or not. */
const NUMBERED_ROW_RE = /^\s*[❯›>*]?\s*(?:\[\d+\]|\d+[.)])\s+\S/

/** How much of the tail can plausibly still be on screen. */
const TAIL_LINES = 14
/** A picker worth flagging offers a choice, not a single row. */
const MIN_ROWS = 2

export interface StalledPromptSignal {
  /** Stable across redraws, so the same stall is not reported twice. */
  fingerprint: string
  /** The marked row, for a one-line "this is what it looks like" preview. */
  preview: string
  optionCount: number
}

function cleanLine(line: string): string {
  return line
    .replace(/[│┃|]/g, ' ')
    .replace(/^[╭╮╯╰─\s]+|[╭╮╯╰─\s]+$/g, '')
    .trimEnd()
}

/**
 * Does the tail of this output look like an open picker?
 *
 * Returns null unless a marked row sits among at least two numbered rows near
 * the end. Callers must additionally require that output has gone quiet and
 * that no real adapter matched — this signal on its own says only "a picker
 * appears to be drawn", never "the user is being asked something".
 */
export function detectStalledPrompt(text: string): StalledPromptSignal | null {
  if (!text) return null

  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean).slice(-TAIL_LINES)
  if (lines.length < MIN_ROWS) return null

  const numbered = lines.filter((line) => NUMBERED_ROW_RE.test(line))
  if (numbered.length < MIN_ROWS) return null

  const marked = numbered.find((line) => MARKED_ROW_RE.test(line))
  if (!marked) return null

  // Identity from the rows themselves: a redrawing TUI repaints the marker and
  // the spacing constantly, so anything less stable would report the same
  // stall over and over.
  const fingerprint = numbered
    .map((line) => line.replace(/^\s*[❯›>*]\s*/, '').replace(/\s+/g, ' ').trim())
    .join('|')

  return { fingerprint, preview: marked.replace(/\s+/g, ' ').trim(), optionCount: numbered.length }
}
