/**
 * Edge tuck: the island slides almost entirely off the screen edge, leaving a
 * sliver behind.
 *
 * `quietIdle` already shrinks the pill, but a smaller thing in the way is
 * still a thing in the way. Tucking removes it from the working area entirely
 * while keeping it one mouse-move from returning, and — because the sliver is
 * still a real window — it can shove itself back out when an agent needs an
 * answer.
 *
 * Deliberately not a drag gesture: `moveIsland` clamps the window inside the
 * work area so it cannot be lost off-screen, and loosening that to allow a
 * "throw it past the edge" flick would reintroduce exactly that risk.
 */
import type { DockSide } from './contracts'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * How much stays on screen. Wide enough to be a comfortable mouse target and
 * to show the agent's status colour, narrow enough to read as "put away".
 */
export const TUCK_SLIVER = 7

/** How long the island must sit idle and untouched before it tucks itself. */
export const AUTO_TUCK_MS = 12_000

/**
 * Where the island sits when tucked against `side` of `area`.
 *
 * The window keeps its size: only its position changes, so nothing has to
 * re-layout on the way out or back. Vertical position is preserved so it
 * returns to where the user left it.
 */
export function tuckedBounds(bounds: Rect, area: Rect, side: DockSide): Rect {
  const x =
    side === 'left'
      ? area.x - (bounds.width - TUCK_SLIVER)
      : area.x + area.width - TUCK_SLIVER
  return { x: Math.round(x), y: bounds.y, width: bounds.width, height: bounds.height }
}

/** True when `bounds` is currently parked off the edge rather than merely docked. */
export function isTuckedAt(bounds: Rect, area: Rect, side: DockSide): boolean {
  const expected = tuckedBounds(bounds, area, side)
  return Math.abs(bounds.x - expected.x) <= 2
}

/**
 * Which edge to tuck against.
 *
 * An explicit dock wins. Otherwise the nearer edge, so tucking an undocked
 * island does not fling it across the display.
 */
export function tuckSideFor(bounds: Rect, area: Rect, docked: DockSide | null): DockSide {
  if (docked) return docked
  const centreX = bounds.x + bounds.width / 2
  return centreX - area.x <= area.x + area.width - centreX ? 'left' : 'right'
}
