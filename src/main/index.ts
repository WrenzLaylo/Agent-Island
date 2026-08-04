import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { discoverAgents } from './agents/discover'
import type { AgentDiscoveryResult, DiscoveredAgent } from './agents/discover'
import { PtyManager, shellHomeCwd } from './agents/process-manager'
import { ApprovalBridgeWatcher, writeDecision } from './agents/approval-bridge'
import type { AgentId, DockSide, IslandWindowLayout } from '../shared/contracts'
import {
  isAgentId,
  MAX_PTY_WRITE_CHARS,
  type PtyResizeRequest,
  type PtyStartRequest,
  type PtyStopRequest,
  type PtyWriteRequest,
  validateSize
} from '../shared/pty-types'

let mainWindow: BrowserWindow | null = null
let discoveryCache: AgentDiscoveryResult | null = null
const ptyManager = new PtyManager({ defaultCwd: shellHomeCwd(), forceKillMs: 1500 })
const bridgeWatcher = new ApprovalBridgeWatcher()

const isDev = !app.isPackaged
const EDGE_GAP = 8
const DOCK_THRESHOLD = 36

/** User-dragged anchor. null = first launch centred near the top. */
let windowAnchor: { x: number; y: number } | null = null
let dockSide: DockSide | null = null

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function displayForWindow(width: number, height: number) {
  if (mainWindow) {
    const bounds = mainWindow.getBounds()
    return screen.getDisplayNearestPoint({
      x: bounds.x + Math.floor(bounds.width / 2),
      y: bounds.y + Math.floor(bounds.height / 2)
    })
  }

  if (windowAnchor) {
    return screen.getDisplayNearestPoint({
      x: windowAnchor.x + Math.floor(width / 2),
      y: windowAnchor.y + Math.floor(height / 2)
    })
  }

  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

function getIslandBounds(width: number, height: number) {
  const display = displayForWindow(width, height)
  const { x: ox, y: oy, width: sw, height: sh } = display.workArea
  const current = mainWindow?.getBounds()

  let x: number
  let y: number

  if (dockSide) {
    x = dockSide === 'left' ? ox + EDGE_GAP : ox + sw - width - EDGE_GAP
    const centreY = current
      ? current.y + current.height / 2
      : (windowAnchor?.y ?? oy + 16) + height / 2
    y = Math.round(centreY - height / 2)
  } else if (current) {
    const centreX = current.x + current.width / 2
    const centreY = current.y + current.height / 2
    x = Math.round(centreX - width / 2)

    // Near the top, grow down like a real Dynamic Island. Elsewhere, grow from centre.
    y = current.y <= oy + 28 ? current.y : Math.round(centreY - height / 2)
  } else {
    x = windowAnchor?.x ?? Math.round(ox + (sw - width) / 2)
    y = windowAnchor?.y ?? Math.round(oy + 12)
  }

  x = clamp(x, ox, Math.max(ox, ox + sw - width))
  y = clamp(y, oy, Math.max(oy, oy + sh - height))
  return { x, y, width, height }
}

function rememberWindowPosition(): void {
  if (!mainWindow) return
  const bounds = mainWindow.getBounds()
  windowAnchor = { x: bounds.x, y: bounds.y }
}

function currentLayout(): IslandWindowLayout {
  return {
    docked: dockSide,
    bounds: mainWindow?.getBounds() ?? null
  }
}

function createWindow(): void {
  const initial = getIslandBounds(318, 66)
  const preloadPath = join(__dirname, '../preload/index.js')
  if (!existsSync(preloadPath)) {
    console.error('Missing preload script:', preloadPath)
  }

  mainWindow = new BrowserWindow({
    ...initial,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    backgroundColor: '#00000000',
    ...(process.platform === 'darwin'
      ? { vibrancy: 'hud' as const, visualEffectState: 'active' as const }
      : {}),
    title: 'Agent Island',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  mainWindow.setBackgroundColor('#00000000')
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
  mainWindow.on('moved', rememberWindowPosition)

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.showInactive()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function resizeIsland(width: number, height: number): void {
  if (!mainWindow) return
  const bounds = getIslandBounds(width, height)
  mainWindow.setBounds(bounds, true)
  rememberWindowPosition()
}

function moveIsland(x: number, y: number): boolean {
  if (!mainWindow || !Number.isFinite(x) || !Number.isFinite(y)) return false

  const bounds = mainWindow.getBounds()
  const display = screen.getDisplayNearestPoint({
    x: Math.round(x + bounds.width / 2),
    y: Math.round(y + bounds.height / 2)
  })
  const area = display.workArea
  const nextX = clamp(Math.round(x), area.x, Math.max(area.x, area.x + area.width - bounds.width))
  const nextY = clamp(Math.round(y), area.y, Math.max(area.y, area.y + area.height - bounds.height))

  mainWindow.setPosition(nextX, nextY, false)
  windowAnchor = { x: nextX, y: nextY }
  return true
}

function finishIslandDrag(): IslandWindowLayout {
  if (!mainWindow) return currentLayout()

  const bounds = mainWindow.getBounds()
  const display = screen.getDisplayNearestPoint({
    x: bounds.x + Math.floor(bounds.width / 2),
    y: bounds.y + Math.floor(bounds.height / 2)
  })
  const area = display.workArea
  const leftDistance = Math.abs(bounds.x - area.x)
  const rightDistance = Math.abs(area.x + area.width - (bounds.x + bounds.width))

  if (leftDistance <= DOCK_THRESHOLD || rightDistance <= DOCK_THRESHOLD) {
    dockSide = leftDistance <= rightDistance ? 'left' : 'right'
    const snapped = getIslandBounds(bounds.width, bounds.height)
    mainWindow.setBounds(snapped, true)
  } else {
    dockSide = null
  }

  rememberWindowPosition()
  return currentLayout()
}

function agentFromDiscovery(agentId: AgentId): DiscoveredAgent | undefined {
  return discoveryCache?.agents.find((agent) => agent.id === agentId)
}

function registerIpc(): void {
  ipcMain.handle('island:resize', (_event, width: number, height: number) => {
    if (
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 56 ||
      width > 1200 ||
      height < 48 ||
      height > 900
    ) {
      throw new Error('Invalid island size')
    }
    resizeIsland(Math.round(width), Math.round(height))
    return true
  })

  ipcMain.on('island:move-window', (_event, x: number, y: number) => {
    moveIsland(x, y)
  })

  ipcMain.handle('island:set-position', (_event, x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid position')
    return moveIsland(x, y)
  })

  ipcMain.handle('island:finish-drag', () => finishIslandDrag())
  ipcMain.handle('island:get-layout', () => currentLayout())
  ipcMain.handle('island:get-bounds', () => mainWindow?.getBounds() ?? null)

  ipcMain.handle('island:discover-agents', async () => {
    discoveryCache = await discoverAgents()
    return discoveryCache
  })

  ipcMain.handle('island:get-discovery', () => discoveryCache)

  ipcMain.handle('island:quit', async () => {
    bridgeWatcher.stop()
    await ptyManager.stopAll()
    app.quit()
  })

  // Legacy PTY APIs kept for compatibility; HUD no longer hosts agents by default.
  ipcMain.handle('pty:start', (_event, request: PtyStartRequest) => {
    if (!request || !isAgentId(request.agentId)) return { ok: false, error: 'Invalid agentId' }
    const sizeError = validateSize(request.cols, request.rows)
    if (sizeError) return { ok: false, error: sizeError }
    const agent = agentFromDiscovery(request.agentId)
    return ptyManager.start(request.agentId, agent, request.cols, request.rows, request.cwd)
  })
  ipcMain.handle('pty:write', (_event, request: PtyWriteRequest) => {
    if (!request || !isAgentId(request.agentId) || typeof request.data !== 'string') {
      return { ok: false, error: 'Invalid write request' }
    }
    if (request.data.length > MAX_PTY_WRITE_CHARS) {
      return { ok: false, error: 'Write payload too large' }
    }
    return ptyManager.write(request.agentId, request.data)
  })
  ipcMain.handle('pty:resize', (_event, request: PtyResizeRequest) => {
    if (!request || !isAgentId(request.agentId)) {
      return { ok: false, error: 'Invalid resize request' }
    }
    return ptyManager.resize(request.agentId, request.cols, request.rows)
  })
  ipcMain.handle('pty:stop', async (_event, request: PtyStopRequest) => {
    if (!request || !isAgentId(request.agentId)) {
      return { ok: false, error: 'Invalid stop request' }
    }
    return ptyManager.stop(request.agentId, Boolean(request.force))
  })
  ipcMain.handle('pty:list', () => ptyManager.list())
  ipcMain.handle('pty:replay', (_event, agentId: unknown) => {
    if (!isAgentId(agentId)) return ''
    return ptyManager.getReplay(agentId)
  })

  ipcMain.handle('bridge:list-approvals', () => bridgeWatcher.list())
  ipcMain.handle(
    'bridge:answer-approval',
    async (_event, request: { requestId?: unknown; decision?: unknown }) => {
      if (!request || typeof request.requestId !== 'string') {
        return { ok: false, error: 'Invalid request' }
      }
      if (request.decision !== 'approve' && request.decision !== 'deny') {
        return { ok: false, error: 'Invalid decision' }
      }
      const choice = request.decision === 'approve' ? 'once' : 'deny'
      try {
        await writeDecision(request.requestId, choice)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}

function wireBridgeEvents(): void {
  bridgeWatcher.on('raised', (request) => {
    mainWindow?.showInactive()
    mainWindow?.moveTop()
    mainWindow?.webContents.send('island:approval', request)
  })
  bridgeWatcher.on('cleared', (request) => {
    mainWindow?.webContents.send('island:approval-cleared', request)
  })
}

app.whenReady().then(async () => {
  registerIpc()
  wireBridgeEvents()
  void bridgeWatcher.start()
  discoveryCache = await discoverAgents()
  createWindow()

  globalShortcut.register('Control+Alt+Space', () => {
    mainWindow?.webContents.send('island:toggle')
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let isQuitting = false

app.on('before-quit', (event) => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  globalShortcut.unregisterAll()
  bridgeWatcher.stop()
  void ptyManager.stopAll().finally(() => {
    app.exit(0)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
