import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/globals.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element missing')
}

// Real desktop blur (backdrop-filter) behind a fully transparent, frameless
// window is only reliable on macOS, where `vibrancy` gives Chromium actual
// pixels to blur. On Windows/Linux a transparent window has nothing behind
// it for the compositor to sample, so backdrop-filter can paint as a solid
// box instead of glass. We tag <html> with the platform so globals.css can
// enable true blur only where it's safe and use a faked-glass gradient
// everywhere else.
document.documentElement.dataset.platform = window.agentIsland?.platform ?? 'unknown'

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
