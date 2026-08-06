import { contextBridge, ipcRenderer } from 'electron'
import type { AgentId, ApprovalDecision, IslandSettings, IslandWindowLayout, TerminalInputPrompt } from '../shared/contracts'
import type {
  AgentSessionRecord,
  SessionPromptRecord
} from '../shared/session-registry'

export interface ShimResult {
  ok: boolean
  installed: string[]
  errors: string[]
}

export interface IslandApi {
  platform: NodeJS.Platform
  resize: (width: number, height: number) => Promise<boolean>
  discoverAgents: () => Promise<unknown>
  getDiscovery: () => Promise<unknown>
  quit: () => Promise<void>
  onToggle: (handler: () => void) => () => void
  onSelectAgent: (handler: (agentId: AgentId) => void) => () => void
  listSessions: () => Promise<AgentSessionRecord[]>
  listSessionPrompts: () => Promise<SessionPromptRecord[]>
  answerSessionPrompt: (request: {
    sessionId: string
    promptId: string
    /** A classified permission decision. */
    decision?: ApprovalDecision
    /** A numbered option, answered by the agent's own digit. */
    optionIndex?: number
    /** Free text, submitted with Enter. */
    text?: string
  }) => Promise<{ ok: boolean; error?: string }>
  onSessionPrompt: (
    handler: (payload: {
      prompt: SessionPromptRecord
      session: AgentSessionRecord
      terminalFocused: boolean
    }) => void
  ) => () => void
  onSessionPromptCleared: (handler: (prompt: SessionPromptRecord) => void) => () => void
  onSessionAdded: (handler: (session: AgentSessionRecord) => void) => () => void
  onSessionRemoved: (handler: (session: AgentSessionRecord) => void) => () => void
  installShims: () => Promise<ShimResult>
  uninstallShims: () => Promise<ShimResult>
  shimStatus: () => Promise<{
    wrapper: string
    electron: string
    wrapperExists: boolean
    launcher: string
    launcherOnPath: boolean
    installed: boolean
  }>
  onApproval: (handler: (request: unknown) => void) => () => void
  onApprovalCleared: (handler: (request: unknown) => void) => () => void
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
  onOutsideClick: (handler: () => void) => () => void
  onWindowFocus: (handler: (focused: boolean) => void) => () => void
  openTerminal: (request: { agentId: AgentId; sessionId?: string }) => Promise<{ ok: boolean; error?: string }>
  onTerminalInput: (handler: (request: TerminalInputPrompt) => void) => () => void
  onTerminalInputCleared: (handler: (request: TerminalInputPrompt) => void) => () => void
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
  listSessions: () => ipcRenderer.invoke('island:list-sessions'),
  listSessionPrompts: () => ipcRenderer.invoke('island:list-session-prompts'),
  answerSessionPrompt: (request) => ipcRenderer.invoke('island:answer-session-prompt', request),
  onSessionPrompt: (handler) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: {
        prompt: SessionPromptRecord
        session: AgentSessionRecord
        terminalFocused: boolean
      }
    ) => handler(payload)
    ipcRenderer.on('island:session-prompt', listener)
    return () => ipcRenderer.removeListener('island:session-prompt', listener)
  },
  onSessionPromptCleared: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionPromptRecord) => handler(payload)
    ipcRenderer.on('island:session-prompt-cleared', listener)
    return () => ipcRenderer.removeListener('island:session-prompt-cleared', listener)
  },
  onSessionAdded: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentSessionRecord) => handler(payload)
    ipcRenderer.on('island:session-added', listener)
    return () => ipcRenderer.removeListener('island:session-added', listener)
  },
  onSessionRemoved: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentSessionRecord) => handler(payload)
    ipcRenderer.on('island:session-removed', listener)
    return () => ipcRenderer.removeListener('island:session-removed', listener)
  },
  installShims: () => ipcRenderer.invoke('island:install-shims'),
  uninstallShims: () => ipcRenderer.invoke('island:uninstall-shims'),
  shimStatus: () => ipcRenderer.invoke('island:shim-status'),
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
  },
  onOutsideClick: (handler) => {
    const listener = () => handler()
    ipcRenderer.on('island:outside-click', listener)
    return () => ipcRenderer.removeListener('island:outside-click', listener)
  },
  onWindowFocus: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, focused: boolean) => handler(focused)
    ipcRenderer.on('island:window-focus', listener)
    return () => ipcRenderer.removeListener('island:window-focus', listener)
  },
  openTerminal: (request) => ipcRenderer.invoke('terminal:handoff', request),
  onTerminalInput: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, request: TerminalInputPrompt) => handler(request)
    ipcRenderer.on('island:terminal-input', listener)
    return () => ipcRenderer.removeListener('island:terminal-input', listener)
  },
  onTerminalInputCleared: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, request: TerminalInputPrompt) => handler(request)
    ipcRenderer.on('island:terminal-input-cleared', listener)
    return () => ipcRenderer.removeListener('island:terminal-input-cleared', listener)
  },
}

contextBridge.exposeInMainWorld('agentIsland', api)
