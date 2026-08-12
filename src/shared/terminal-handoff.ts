/**
 * What handoff can and cannot promise for a given terminal.
 *
 * Raising a window and selecting the right tab inside it are different
 * problems. Windows Terminal can be driven to a specific tab, via a title
 * marker and UI Automation. VS Code cannot: it exposes no way for an outside
 * process to focus one of its integrated terminals, and there is no CLI or URI
 * for it short of shipping a VS Code extension.
 *
 * The island resolves a VS Code session's window through process ancestry, so
 * `hwnd` is set and handoff *appears* to work. It brings the right window
 * forward and stops there — leaving the user looking at whichever terminal was
 * last active, which with several open is usually the wrong one, with nothing
 * on screen admitting it.
 *
 * Saying so is the fix. The alternative is an interface that quietly does
 * three quarters of what its button says.
 */
import type { TerminalKind } from './session-registry'

/** Whether the exact tab can be brought to the front, not just the window. */
export function canSelectTab(kind: TerminalKind | undefined): boolean {
  return kind === 'windows-terminal'
}

/**
 * A caveat to show beside the handoff button, or null when there is none.
 *
 * Only returned for hosts that hold several sessions at once. A conhost or
 * mintty window *is* the session, so raising it lands exactly where the user
 * expects and a note would be noise.
 */
export function handoffCaveat(kind: TerminalKind | undefined, terminalLabel?: string): string | null {
  if (canSelectTab(kind)) return null
  if (kind !== 'vscode') return null
  const label = terminalLabel ?? 'VS Code'
  return `${label} will be brought to the front, but Agent Island cannot select the terminal tab — pick it yourself if several are open.`
}
