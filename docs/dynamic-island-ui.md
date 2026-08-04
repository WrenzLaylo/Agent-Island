# Dynamic Island UI

The overlay now uses a restrained, native-looking dark-glass design rather than a decorative “AI dashboard” treatment.

## Compact state

- 318 × 66 px floating window with a 56 px visual pill after transparent breathing room.
- Clear Hermes monogram, two-line status text, quiet activity bars, and a subtle expand affordance.
- No fake camera lens, grain texture, oversized glow, or dense decorative chrome.

## Docked state

- Snaps to either display edge and resizes to a 62 × 62 px window.
- Displays a compact circular Hermes mark with a live status dot.
- Approval count appears as a small amber badge when required.

## Approval state

- Opens automatically when a bridge approval is raised.
- Uses a restrained amber edge and one-time attention pulse.
- Keeps the action, risk, command, context, and decision buttons readable without looking like a full dashboard.

## Motion

Framer Motion powers the spring-based morphing, entry/exit states, button feedback, and approval attention animation. Reduced-motion system preferences are respected.

## Dragging

The renderer streams pointer movement to Electron. On pointer release, the main process decides whether the island should remain free-floating or snap to the nearest left/right edge.
