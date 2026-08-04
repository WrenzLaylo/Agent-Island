import { contextBridge, ipcRenderer } from 'electron'
import type { AgentId } from '../shared/contracts'

export interface IslandApi {
  resize: (width: number, height: number) => Promise<boolean>
  discoverAgents: () => Promise<unknown>
  getDiscovery: () => Promise<unknown>
  quit: () => Promise<void>
  onToggle: (handler: () => void) => () => void
  onSelectAgent: (handler: (agentId: AgentId) => void) => () => void
}

const api: IslandApi = {
  resize: (width, height) => ipcRenderer.invoke('island:resize', width, height),
  discoverAgents: () => ipcRenderer.invoke('island:discover-agents'),
  getDiscovery: () => ipcRenderer.invoke('island:get-discovery'),
  quit: () => ipcRenderer.invoke('island:quit'),
  onToggle: (handler) => {
    const listener = () => handler()
    ipcRenderer.on('island:toggle', listener)
    return () => ipcRenderer.removeListener('island:toggle', listener)
  },
  onSelectAgent: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: AgentId) => handler(agentId)
    ipcRenderer.on('island:select-agent', listener)
    return () => ipcRenderer.removeListener('island:select-agent', listener)
  }
}

contextBridge.exposeInMainWorld('agentIsland', api)
