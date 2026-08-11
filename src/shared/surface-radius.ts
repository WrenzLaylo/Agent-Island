/**
 * Corner radius as a pure function of the surface's current size.
 *
 * Previously the radius came from a class — 999px for the pill, 50% for the
 * docked orb, 18px for every card — with no transition between them. The
 * geometry springs for up to ~380ms in the main process while the class flips
 * in a single frame, so the corner *popped* part-way through every morph. A
 * radius that flows with the shape is the defining trait of this kind of
 * overlay, and it was the one thing not animating.
 *
 * Deriving it from the measured size fixes that without synchronising
 * anything: the renderer's viewport is resized by the same spring, so the
 * radius is correct on every frame by construction. There is no duration to
 * keep in step with the main process, and no way for the two to disagree.
 */

/** At or below this, the shape is a pill or an orb: fully rounded. */
export const PILL_MAX = 56
/** At or above this, the shape is a card and takes the card radius. */
export const CARD_MIN = 120
export const CARD_RADIUS = 18

export function radiusForSize(width: number, height: number): number {
  const shortest = Math.min(width, height)
  if (!Number.isFinite(shortest) || shortest <= 0) return CARD_RADIUS

  // Fully rounded: half the short side is a pill horizontally and a circle
  // when the sides are equal, which is exactly the docked orb.
  if (shortest <= PILL_MAX) return shortest / 2

  if (shortest >= CARD_MIN) return CARD_RADIUS

  /*
   * Between the two, interpolate from "half the short side" down to the card
   * radius. Without this the radius would jump from 28 to 18 the moment the
   * surface crossed 56px, which is the same pop in a different place.
   */
  const t = (shortest - PILL_MAX) / (CARD_MIN - PILL_MAX)
  return PILL_MAX / 2 + (CARD_RADIUS - PILL_MAX / 2) * t
}
