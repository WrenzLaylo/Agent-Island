import { describe, expect, it } from 'vitest'
import { isTuckedAt, TUCK_SLIVER, tuckedBounds, tuckSideFor } from '../../src/shared/tuck'

const AREA = { x: 0, y: 0, width: 1920, height: 1040 }
/** A second display to the left of the primary, which is where x goes negative. */
const LEFT_AREA = { x: -1920, y: 0, width: 1920, height: 1080 }

describe('edge tuck geometry', () => {
  it('leaves exactly a sliver on screen', () => {
    const pill = { x: 8, y: 300, width: 300, height: 52 }
    const left = tuckedBounds(pill, AREA, 'left')
    expect(left.x + left.width - AREA.x).toBe(TUCK_SLIVER)

    const right = tuckedBounds(pill, AREA, 'right')
    expect(AREA.x + AREA.width - right.x).toBe(TUCK_SLIVER)
  })

  it('keeps the sliver reachable with the mouse', () => {
    // The sliver is the only way back other than the tray, so it has to be a
    // real target rather than a hairline.
    expect(TUCK_SLIVER).toBeGreaterThanOrEqual(4)
  })

  it('does not move vertically or resize', () => {
    const card = { x: 40, y: 260, width: 400, height: 532 }
    const tuckedCard = tuckedBounds(card, AREA, 'right')
    expect(tuckedCard.y).toBe(260)
    expect(tuckedCard.width).toBe(400)
    expect(tuckedCard.height).toBe(532)
  })

  it('tucks against a display whose origin is negative', () => {
    // A second monitor to the left has negative coordinates; treating the work
    // area origin as zero would park the island on the wrong screen entirely.
    const pill = { x: -1900, y: 200, width: 300, height: 52 }
    const tuckedPill = tuckedBounds(pill, LEFT_AREA, 'left')
    expect(tuckedPill.x + tuckedPill.width - LEFT_AREA.x).toBe(TUCK_SLIVER)
    expect(tuckedPill.x).toBeLessThan(LEFT_AREA.x)
  })

  it('recognises its own tucked position', () => {
    const pill = { x: 8, y: 300, width: 300, height: 52 }
    const parked = tuckedBounds(pill, AREA, 'right')
    expect(isTuckedAt(parked, AREA, 'right')).toBe(true)
    expect(isTuckedAt(pill, AREA, 'right')).toBe(false)
  })

  it('follows an explicit dock rather than proximity', () => {
    // Docked left but sitting near the right edge mid-drag: the dock wins, or
    // the island would reappear on the opposite side from where it went.
    const pill = { x: 1600, y: 300, width: 300, height: 52 }
    expect(tuckSideFor(pill, AREA, 'left')).toBe('left')
  })

  it('picks the nearer edge when undocked', () => {
    expect(tuckSideFor({ x: 20, y: 0, width: 300, height: 52 }, AREA, null)).toBe('left')
    expect(tuckSideFor({ x: 1500, y: 0, width: 300, height: 52 }, AREA, null)).toBe('right')
  })

  it('is reversible', () => {
    // Tucking must not lose the size the island had, or it would come back a
    // different shape from the one that went away.
    const card = { x: 700, y: 120, width: 400, height: 172 }
    const parked = tuckedBounds(card, AREA, 'right')
    expect({ width: parked.width, height: parked.height, y: parked.y }).toEqual({
      width: card.width,
      height: card.height,
      y: card.y
    })
  })
})
