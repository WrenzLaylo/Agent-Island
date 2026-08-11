/**
 * Did the user just answer a live prompt in the terminal itself?
 *
 * The island learns that a prompt is gone by watching the agent's output, and
 * that check is unavoidably a heuristic: a panel counts as live until enough
 * output follows it (LIVE_TAIL_CHARS). The threshold has to be generous
 * because agents repaint spinners and key hints *below* a panel that is
 * genuinely still waiting. The cost is the opposite error — answer in the
 * terminal, have the agent print a short result, and the island keeps showing
 * a card for a request that was settled seconds ago.
 *
 * Keystrokes are the direct signal the output stream cannot provide. The
 * wrapper already forwards stdin to the pty, so it can see the answer being
 * typed at the moment it happens.
 */

const CR = 13
const LF = 10

/**
 * Deliberately narrow. Only input that plausibly *answers* a numbered panel
 * counts: the digit of an option the agent actually offered, or a submit.
 *
 * Arrow keys, Ctrl+C, and ordinary typing are excluded on purpose. Clearing on
 * any keypress would drop a genuinely pending approval the moment the user
 * nudged the selection — and once cleared, the answered-fingerprint guard stops
 * it being raised again, so the request would be lost from the island for good.
 */
export function answersLivePrompt(input: string, offeredIndexes: readonly number[]): boolean {
  if (!input) return false

  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)

    // Enter confirms whichever row the agent has highlighted.
    if (code === CR || code === LF) return true

    // A digit only counts when it names an option that exists. Agents number
    // from 1, so a lone "0" or a digit past the end of the list is something
    // else being typed.
    if (code >= 48 && code <= 57) {
      const digit = code - 48
      if (offeredIndexes.includes(digit)) return true
    }
  }

  return false
}

/**
 * Could this input answer *some* numbered panel, when we do not yet know which
 * options were offered?
 *
 * Used in the window between an agent drawing a panel and the debounced scan
 * noticing it. Necessarily looser than answersLivePrompt — any digit counts,
 * because the option list has not been parsed yet — so callers must confirm a
 * panel is actually on screen before acting on it.
 */
export function mayAnswerSomePrompt(input: string): boolean {
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)
    if (code === 13 || code === 10) return true
    if (code >= 49 && code <= 57) return true
  }
  return false
}
