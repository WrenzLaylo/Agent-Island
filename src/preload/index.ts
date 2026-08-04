import { contextBridge, ipcRenderer } from 'electron'
import type { AgentId } from '../shared/contracts'
import type {
  PtyDataEvent,
  PtyExitEvent,
  PtyResizeRequest,
  PtySessionInfo,
  PtyStartRequest,
  PtyStartResult,
  PtyStopRequest,
  PtyWriteRequest
} from '../shared/pty-types'

export interface IslandApi {
  resize: (width: number, height: number) => Promise<boolean>
  discoverAgents: () => Promise<unknown>
  getDiscovery: () => Promise<unknown>
  quit: () => Promise<void>
  onToggle: (handler: () => void) => () => void
  onSelectAgent: (handler: (agentId: AgentId) => void) => () => void
  ptyStart: (request: PtyStartRequest) => Promise<PtyStartResult>
  ptyWrite: (request: PtyWriteRequest) => Promise<{ ok: boolean; error?: string }>
  ptyResize: (request: PtyResizeRequest) => Promise<{ ok: boolean; error?: string }>
  ptyStop: (request: PtyStopRequest) => Promise<{ ok: boolean; error?: string }>
  ptyList: () => Promise<PtySessionInfo[]>
  ptyReplay: (agentId: AgentId) => Promise<string>
  onPtyData: (handler: (event: PtyDataEvent) => void) => () => void
  onPtyExit: (handler: (event: PtyExitEvent) => void) => () => void
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
  },
  ptyStart: (request) => ipcRenderer.invoke('pty:start', request),
  ptyWrite: (request) => ipcRenderer.invoke('pty:write', request),
  ptyResize: (request) => ipcRenderer.invoke('pty:resize', request),
  ptyStop: (request) => ipcRenderer.invoke('pty:stop', request),
  ptyList: () => ipcRenderer.invoke('pty:list'),
  ptyReplay: (agentId) => ipcRenderer.invoke('pty:replay', agentId),
  onPtyData: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PtyDataEvent) => handler(payload)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.removeListener('pty:data', listener)
  },
  onPtyExit: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PtyExitEvent) => handler(payload)
    ipcRenderer.on('pty:exit', listener)
    return () => ipcRenderer.removeListener('pty:exit', listener)
  }
}

contextBridge.exposeInMainWorld('agentIsland', api)
