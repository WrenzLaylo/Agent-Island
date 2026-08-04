import { contextBridge, ipcRenderer } from 'electron'
import type { AgentId, ApprovalDecision, IslandSettings, IslandWindowLayout } from '../shared/contracts'
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
  platform: NodeJS.Platform
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
  onPtySession: (handler: (session: PtySessionInfo) => void) => () => void
  ptyAnswerApproval: (request: {
    agentId: AgentId
    requestId: string
    decision: ApprovalDecision
  }) => Promise<{ ok: boolean; error?: string }>
  onApproval: (handler: (request: unknown) => void) => () => void
  onApprovalCleared: (handler: (request: unknown) => void) => () => void
  onApprovalAnswered: (
    handler: (payload: { agentId: AgentId; requestId: string; decision: ApprovalDecision }) => void
  ) => () => void
  listBridgeApprovals: () => Promise<unknown>
  answerBridgeApproval: (request: {
    requestId: string
    decision: ApprovalDecision
  }) => Promise<{ ok: boolean; error?: string }>
  moveWindow: (x: number, y: number) => void
  setPosition: (x: number, y: number) => Promise<boolean>
  finishDrag: () => Promise<IslandWindowLayout>
  returnHome: () => Promise<IslandWindowLayout>
  getLayout: () => Promise<IslandWindowLayout>
  getBounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>
  getSettings: () => Promise<IslandSettings>
  updateSettings: (patch: Partial<IslandSettings>) => Promise<IslandSettings>
  onSettingsChanged: (handler: (settings: IslandSettings) => void) => () => void
  onOpenSettings: (handler: () => void) => () => void
  onReturnHome: (handler: () => void) => () => void
}

const api: IslandApi = {
  platform: process.platform,
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
  },
  onPtySession: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PtySessionInfo) => handler(payload)
    ipcRenderer.on('pty:session', listener)
    return () => ipcRenderer.removeListener('pty:session', listener)
  },
  ptyAnswerApproval: (request) => ipcRenderer.invoke('pty:answer-approval', request),
  onApproval: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload)
    ipcRenderer.on('island:approval', listener)
    return () => ipcRenderer.removeListener('island:approval', listener)
  },
  onApprovalCleared: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload)
    ipcRenderer.on('island:approval-cleared', listener)
    return () => ipcRenderer.removeListener('island:approval-cleared', listener)
  },
  onApprovalAnswered: (handler) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { agentId: AgentId; requestId: string; decision: ApprovalDecision }
    ) => handler(payload)
    ipcRenderer.on('island:approval-answered', listener)
    return () => ipcRenderer.removeListener('island:approval-answered', listener)
  },
  listBridgeApprovals: () => ipcRenderer.invoke('bridge:list-approvals'),
  answerBridgeApproval: (request) => ipcRenderer.invoke('bridge:answer-approval', request),
  moveWindow: (x, y) => ipcRenderer.send('island:move-window', x, y),
  setPosition: (x, y) => ipcRenderer.invoke('island:set-position', x, y),
  finishDrag: () => ipcRenderer.invoke('island:finish-drag'),
  returnHome: () => ipcRenderer.invoke('island:return-home'),
  getLayout: () => ipcRenderer.invoke('island:get-layout'),
  getBounds: () => ipcRenderer.invoke('island:get-bounds'),
  getSettings: () => ipcRenderer.invoke('island:get-settings'),
  updateSettings: (patch) => ipcRenderer.invoke('island:update-settings', patch),
  onSettingsChanged: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, settings: IslandSettings) => handler(settings)
    ipcRenderer.on('island:settings-changed', listener)
    return () => ipcRenderer.removeListener('island:settings-changed', listener)
  },
  onOpenSettings: (handler) => {
    const listener = () => handler()
    ipcRenderer.on('island:open-settings', listener)
    return () => ipcRenderer.removeListener('island:open-settings', listener)
  },
  onReturnHome: (handler) => {
    const listener = () => handler()
    ipcRenderer.on('island:return-home', listener)
    return () => ipcRenderer.removeListener('island:return-home', listener)
  }
}

contextBridge.exposeInMainWorld('agentIsland', api)
