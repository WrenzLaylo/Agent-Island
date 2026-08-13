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

/**
 * The headline for a handoff card.
 *
 * Every source of these already writes one: `titleFor` in terminal-input has a
 * sentence per kind ("Claude has a plan ready", "Claude needs authentication"),
 * and a mirrored permission carries the agent's own words ("Claude needs your
 * permission to use Bash"). The card discarded all of it for a hardcoded
 * "<agent> needs input" — the one sentence every card already had in common,
 * and so the only one that told the user nothing about this card.
 */
export function handoffHeadline(title: string | undefined, agentLabel: string): string {
  const trimmed = title?.trim()
  return trimmed ? trimmed : `${agentLabel} needs input`
}

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
 *
 * `canRaiseWindow` matters because this caveat is about what happens *after* a
 * window comes forward, and two different things now report themselves as
 * `vscode`. An integrated terminal resolves an hwnd through process ancestry,
 * so the window is raised and only the tab is in doubt — the case this text was
 * written for. A session hosted by the VS Code extension's hooks has no window
 * at all, and on that card the note appeared directly beneath "does not expose a
 * window Agent Island can raise", promising in one sentence what the line above
 * had just ruled out.
 */
export function handoffCaveat(
  kind: TerminalKind | undefined,
  terminalLabel?: string,
  canRaiseWindow = true
): string | null {
  if (!canRaiseWindow) return null
  if (canSelectTab(kind)) return null
  if (kind !== 'vscode') return null
  const label = terminalLabel ?? 'VS Code'
  return `${label} will be brought to the front, but Agent Island cannot select the terminal tab — pick it yourself if several are open.`
}
