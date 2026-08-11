import { describe, expect, it } from 'vitest'
import { CARD_RADIUS, radiusForSize } from '../../src/shared/surface-radius'

describe('surface radius', () => {
  it('draws the docked orb as a true circle', () => {
    // 44x44 and 56x56 are the docked sizes; half the side is exactly 50%.
    expect(radiusForSize(44, 44)).toBe(22)
    expect(radiusForSize(56, 56)).toBe(28)
  })

  it('draws the collapsed pill fully rounded', () => {
    expect(radiusForSize(116, 32)).toBe(16)
    expect(radiusForSize(300, 52)).toBe(26)
  })

  it('draws a card at the card radius', () => {
    expect(radiusForSize(400, 172)).toBe(CARD_RADIUS)
    expect(radiusForSize(400, 532)).toBe(CARD_RADIUS)
    expect(radiusForSize(440, 600)).toBe(CARD_RADIUS)
    expect(radiusForSize(392, 196)).toBe(CARD_RADIUS)
  })

  it('never jumps, at any size on the way between them', () => {
    /*
     * The point of the whole change. Walking every height a morph passes
     * through, no single pixel of growth may move the radius by more than a
     * pixel — that discontinuity is exactly the pop this replaced.
     */
    let previous = radiusForSize(400, 24)
    for (let height = 25; height <= 600; height++) {
      const radius = radiusForSize(400, height)
      expect(Math.abs(radius - previous)).toBeLessThanOrEqual(1)
      previous = radius
    }
  })

  it('is never larger than half the shortest side', () => {
    // A radius above this is silently clamped by the renderer, which would
    // make the shape stop matching the value being animated.
    for (const [w, h] of [[116, 32], [300, 52], [44, 44], [400, 96], [400, 532]]) {
      expect(radiusForSize(w, h)).toBeLessThanOrEqual(Math.min(w, h) / 2)
    }
  })

  it('survives a degenerate size during the first paint', () => {
    expect(radiusForSize(0, 0)).toBe(CARD_RADIUS)
    expect(radiusForSize(Number.NaN, 100)).toBe(CARD_RADIUS)
  })
})
