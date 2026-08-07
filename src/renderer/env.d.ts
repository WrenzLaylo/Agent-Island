/// <reference types="vite/client" />
// Needed for `import.meta.glob`, which AgentMark uses to discover agent marks.
// Without it the build succeeds (Vite transforms the call regardless) while
// tsc fails — the two disagreeing is exactly how this went unnoticed.

// `../../preload/index` resolved to nothing, which silently degraded the whole
// bridge to `any` in the renderer.
import type { IslandApi } from '../preload/index'

declare global {
  interface Window {
    agentIsland: IslandApi
  }
}

export {}
