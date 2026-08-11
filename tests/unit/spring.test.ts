import { describe, expect, it } from 'vitest'
import {
  axisSettled,
  BASE_OMEGA,
  frameIntervalMs,
  MAX_OMEGA,
  moveDistance,
  omegaForDistance,
  SPRING_EPSILON,
  SPRING_SUB_STEP,
  stepSpringAxis,
  type SpringAxis
} from '../../src/shared/spring'

/** Integrate a real step response and report when it settles, in seconds. */
function settleTime(distance: number, omega = omegaForDistance(distance)): number {
  const axis: SpringAxis = { value: distance, velocity: 0, target: 0 }
  let t = 0
  while (t < 5) {
    stepSpringAxis(axis, SPRING_SUB_STEP, omega)
    t += SPRING_SUB_STEP
    if (axisSettled(axis, omega)) return t
  }
  return t
}

/** Fastest speed reached during the move, in px/s. */
function peakSpeed(distance: number, omega = omegaForDistance(distance)): number {
  const axis: SpringAxis = { value: distance, velocity: 0, target: 0 }
  let peak = 0
  for (let t = 0; t < 2; t += SPRING_SUB_STEP) {
    stepSpringAxis(axis, SPRING_SUB_STEP, omega)
    peak = Math.max(peak, Math.abs(axis.velocity))
    if (axisSettled(axis, omega)) break
  }
  return peak
}

describe('spring tuning', () => {
  it('never overshoots the target', () => {
    // Critical damping is the whole reason a morphing container does not look
    // like it is bouncing off its own edges.
    for (const distance of [4, 40, 200, 500]) {
      const axis: SpringAxis = { value: distance, velocity: 0, target: 0 }
      const omega = omegaForDistance(distance)
      for (let t = 0; t < 2; t += SPRING_SUB_STEP) {
        stepSpringAxis(axis, SPRING_SUB_STEP, omega)
        expect(axis.value).toBeGreaterThanOrEqual(-SPRING_EPSILON)
      }
    }
  })

  it('makes short moves crisp instead of mushy', () => {
    // The defect this tuning exists to fix: at a flat omega of 22 a five-pixel
    // nudge still took ~140ms, which reads as lag rather than motion.
    expect(settleTime(5)).toBeLessThan(0.1)
    expect(settleTime(30)).toBeLessThan(0.16)
  })

  it('leaves long moves at their original pace', () => {
    // ~380ms for a full expansion was already right; slowing it further to cap
    // peak speed would only make it sluggish.
    expect(omegaForDistance(500)).toBe(BASE_OMEGA)
    expect(settleTime(500)).toBeGreaterThan(0.3)
    expect(settleTime(500)).toBeLessThan(0.45)
  })

  it('takes longer the further it travels', () => {
    // Monotonic, or the motion stops describing the distance it covers.
    const times = [5, 30, 120, 300, 500].map((d) => settleTime(d))
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1])
    }
  })

  it('keeps short moves from whipping', () => {
    // Peak speed should still scale with distance, just not by 100x.
    expect(peakSpeed(5)).toBeLessThan(peakSpeed(500))
    expect(peakSpeed(5)).toBeLessThan(150)
  })

  it('clamps stiffness so a one-pixel correction is still motion', () => {
    expect(omegaForDistance(0.5)).toBe(MAX_OMEGA)
    expect(omegaForDistance(0)).toBe(MAX_OMEGA)
    expect(omegaForDistance(Number.NaN)).toBe(MAX_OMEGA)
  })

  it('measures one distance across all four axes', () => {
    // A per-axis stiffness would let width settle before height, skewing the
    // shape part-way through the morph.
    const distance = moveDistance(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 3, y: 4, width: 100, height: 100 }
    )
    expect(distance).toBe(5)
  })
})

describe('frame pacing', () => {
  it('paces to the panel rather than a fixed 8ms timer', () => {
    expect(frameIntervalMs(60)).toBeCloseTo(16.667, 2)
    expect(frameIntervalMs(144)).toBeCloseTo(6.944, 2)
  })

  it('falls back to 60Hz when the display reports nothing usable', () => {
    for (const value of [undefined, 0, -1, Number.NaN]) {
      expect(frameIntervalMs(value as number)).toBeCloseTo(16.667, 2)
    }
  })

  it('refuses absurd refresh rates', () => {
    // A bad value here becomes a busy loop pushing setBounds.
    expect(frameIntervalMs(100_000)).toBeCloseTo(1000 / 360, 3)
    expect(frameIntervalMs(1)).toBeCloseTo(1000 / 24, 3)
  })
})
