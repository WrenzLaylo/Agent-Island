import type { IslandApi } from '../../preload/index'

declare global {
  interface Window {
    agentIsland: IslandApi
  }
}

export {}
