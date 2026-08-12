/**
 * Claude's starburst, animated the way the CLI animates it.
 *
 * Not a rotation. The frames of the reference art differ by *petal length* —
 * each spoke extends and retracts, so the mark twinkles in place. Spinning the
 * whole glyph reads as a logo that has come loose; this reads as the thing
 * working.
 *
 * Drawn as twelve separate spokes rather than reusing `claude.svg`, which is a
 * single compound path with no way to address one petal. Geometry only: it
 * inherits `currentColor`, so it stays the agent's colour wherever it is used.
 */

const PETALS = 12
/** One full cycle, staggered across the spokes so the pulse travels around. */
const CYCLE_SECONDS = 1.1

export function ClaudeSpinner({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`claude-spinner ${className}`}
      viewBox="0 0 24 24"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      {Array.from({ length: PETALS }, (_, index) => (
        // The rotation lives on the group as an attribute so the CSS transform
        // on the spoke itself is free to animate its length.
        <g key={index} transform={`rotate(${(index * 360) / PETALS} 12 12)`}>
          <rect
            x="11.1"
            y="1.7"
            width="1.8"
            height="7.2"
            rx="0.9"
            style={{ animationDelay: `${((index % PETALS) * CYCLE_SECONDS) / PETALS}s` }}
          />
        </g>
      ))}
    </svg>
  )
}
