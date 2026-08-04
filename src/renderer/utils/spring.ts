export interface Vec2 {
  x: number
  y: number
}

export interface SpringOptions {
  from: Vec2
  to: Vec2
  velocity?: Vec2
  /** Higher = snappier pull toward the target. */
  stiffness?: number
  /** Lower = more overshoot/bounce, higher = settles faster. */
  damping?: number
  mass?: number
  onUpdate: (point: Vec2) => void
  onComplete: () => void
}

/**
 * Frame-driven spring, used to animate the native window position back to
 * an origin point (e.g. "drag released away from any dock edge, bounce
 * back home"). Runs on real elapsed time rather than an assumed 60Hz tick,
 * so it stays consistent across displays/refresh rates. Returns a cancel
 * function.
 */
export function animateSpring({
  from,
  to,
  velocity = { x: 0, y: 0 },
  stiffness = 380,
  damping = 26,
  mass = 1,
  onUpdate,
  onComplete
}: SpringOptions): () => void {
  const pos: Vec2 = { x: from.x, y: from.y }
  const vel: Vec2 = { x: velocity.x, y: velocity.y }
  const restDelta = 0.4
  const restSpeed = 6
  let rafId = 0
  let lastTime = performance.now()
  let cancelled = false

  const step = (now: number) => {
    if (cancelled) return
    const dt = Math.min((now - lastTime) / 1000, 1 / 30)
    lastTime = now

    const dx = pos.x - to.x
    const dy = pos.y - to.y
    const ax = (-stiffness * dx - damping * vel.x) / mass
    const ay = (-stiffness * dy - damping * vel.y) / mass

    vel.x += ax * dt
    vel.y += ay * dt
    pos.x += vel.x * dt
    pos.y += vel.y * dt

    const settled =
      Math.abs(dx) < restDelta &&
      Math.abs(dy) < restDelta &&
      Math.abs(vel.x) < restSpeed &&
      Math.abs(vel.y) < restSpeed

    if (settled) {
      onUpdate(to)
      onComplete()
      return
    }

    onUpdate(pos)
    rafId = requestAnimationFrame(step)
  }

  rafId = requestAnimationFrame(step)

  return () => {
    cancelled = true
    cancelAnimationFrame(rafId)
  }
}
