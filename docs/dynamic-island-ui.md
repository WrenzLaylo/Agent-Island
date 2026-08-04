# Dynamic Island UI

The overlay now uses a restrained, native-looking dark-glass design rather than a decorative “AI dashboard” treatment.

## Compact state

- 318 × 66 px floating window with a 56 px visual pill after transparent breathing room.
- Clear Hermes monogram, two-line status text, quiet activity bars, and a subtle expand affordance.
- No fake camera lens, oversized glow, or dense decorative chrome. A near-invisible
  frosted grain (5% opacity, blended, self-contained SVG noise) is layered in purely to
  sell the glass material — see "Glass material" below for why.

## Glass material

`backdrop-filter` (real desktop blur) only works reliably on macOS, where `vibrancy`
gives Chromium actual desktop pixels behind the transparent frameless window to blur.
On Windows/Linux the same `transparent: true` window has nothing behind it for the
compositor to sample, and `backdrop-filter` can paint as an opaque box instead of glass
— this was the "may background talaga siya" bug (a visible rectangle behind the pill).

Fix: `main/index.ts` exposes `process.platform` via preload; `main.tsx` writes it to
`document.documentElement.dataset.platform`. `globals.css` only turns on
`backdrop-filter` under `[data-platform="darwin"]`. Every platform gets the same look
at rest via a layered gradient + grain "faked glass" recipe in `.island-surface`, so
the design doesn't visually depend on which platform is doing the blurring.

## Docked state

- Snaps to either display edge and resizes to a 62 × 62 px window.
- Displays a compact circular Hermes mark with a live status dot.
- Approval count appears as a small amber badge when required.

## Approval state

- Opens automatically when a bridge approval is raised.
- Uses a restrained amber edge and one-time attention pulse.
- Keeps the action, risk, command, context, and decision buttons readable without looking like a full dashboard.

## Motion

Framer Motion powers the spring-based morphing, entry/exit states, button feedback, and
approval attention animation (shared `spring = { stiffness: 420, damping: 28, mass: 0.9 }`,
tuned for a touch of iOS-style overshoot instead of a critically-damped flat settle).
Reduced-motion system preferences are respected. Tap/press feedback on the pill and orb
uses a plain CSS `:active` scale rather than a Framer gesture, since the pointer is
already manually captured for dragging.

## Dragging

`App.tsx` streams pointer movement to Electron via `moveWindow`, throttled to one IPC
call per animation frame (`requestAnimationFrame`) instead of one per raw pointer
sample — unthrottled sends were the main cause of choppy dragging on fast mice/trackpads.

On release, the main process (`island:finish-drag`) decides whether the drop point is
close enough to a screen edge to dock. If it docks, the existing snap behavior applies.
If it doesn't, the island doesn't stay wherever it was dropped — `src/renderer/utils/spring.ts`
runs a small velocity-aware spring simulation that bounces the window back to the exact
position it was in before the drag started (its "origin"), the same rubber-band feel as
an iOS control dropped outside a valid target.
