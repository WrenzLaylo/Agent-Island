// `../../preload/index` resolved to nothing, which silently degraded the whole
// bridge to `any` in the renderer.
import type { IslandApi } from '../preload/index'

declare global {
  interface Window {
    agentIsland: IslandApi
  }
}

export {}
