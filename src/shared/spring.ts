/**
 * The geometry spring, extracted so its tuning is testable without opening a
 * window.
 *
 * Critically damped (`zeta = 1`) throughout: a morphing container that
 * overshoots looks like it is bouncing off its own edges. What varies is
 * `omega`, and only for short moves — see `omegaForDistance`.
 */

/** Reference stiffness, used unchanged for any move of REFERENCE_DISTANCE or more. */
export const BASE_OMEGA = 22
/** Below this, the move gets progressively stiffer. */
export const REFERENCE_DISTANCE = 120
/** Ceiling, so a one-pixel correction still reads as motion rather than a jump. */
export const MAX_OMEGA = 45
/** Snap once within a pixel: the last pixel takes as long as the first fifty. */
export const SPRING_EPSILON = 0.9
export const SPRING_SUB_STEP = 1 / 240

/**
 * Stiffness for a move of `distance` pixels.
 *
 * A single omega cannot serve every transition, but not for the reason it
 * first appears. Settle time for a critically damped spring grows only
 * logarithmically with distance, so at omega 22 a 500px morph takes ~380ms
 * and a 5px nudge still takes ~140ms. The large moves are fine — 380ms for a
 * full expansion is about right, and slowing them further to cap peak speed
 * makes them sluggish. It is the short moves that are wrong: 140ms to travel
 * five pixels reads as lag, not motion.
 *
 * So omega is raised for short moves and left alone for long ones. The result
 * is monotonic — a bigger move always takes longer:
 *
 *     5px   -> omega 45, settles in ~65ms
 *     30px  -> omega 44, settles in ~115ms
 *     120px -> omega 22, settles in ~300ms
 *     500px -> omega 22, settles in ~380ms
 */
export function omegaForDistance(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return MAX_OMEGA
  const scale = Math.sqrt(REFERENCE_DISTANCE / distance)
  return Math.min(MAX_OMEGA, BASE_OMEGA * Math.max(1, scale))
}

/**
 * How far the window is travelling, across all four axes at once.
 *
 * One distance for the whole move, never one per axis: separate stiffnesses
 * would let width finish before height and the shape would visibly skew
 * part-way through the morph.
 */
export function moveDistance(
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number }
): number {
  return Math.hypot(to.x - from.x, to.y - from.y, to.width - from.width, to.height - from.height)
}

export interface SpringAxis {
  value: number
  velocity: number
  target: number
}

export function stepSpringAxis(axis: SpringAxis, dt: number, omega: number): void {
  const displacement = axis.value - axis.target
  const acceleration = -omega * omega * displacement - 2 * omega * axis.velocity
  axis.velocity += acceleration * dt
  axis.value += axis.velocity * dt
}

export function axisSettled(axis: SpringAxis, omega: number): boolean {
  return (
    Math.abs(axis.value - axis.target) < SPRING_EPSILON &&
    Math.abs(axis.velocity) < SPRING_EPSILON * omega
  )
}

/**
 * Frame interval for a display running at `hz`.
 *
 * The physics is sub-stepped and therefore correct at any frame rate, but the
 * *presentation* was not: a fixed 8ms timer beats against a 60Hz refresh, so
 * frames landed unevenly and the morph juddered even though the maths was
 * exact. Pacing to the panel keeps one integration per presented frame.
 */
export function frameIntervalMs(hz: number | undefined): number {
  if (!hz || !Number.isFinite(hz) || hz <= 0) return 1000 / 60
  return 1000 / Math.min(Math.max(hz, 24), 360)
}
