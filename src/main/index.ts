import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { discoverAgents } from './agents/discover'
import type { AgentDiscoveryResult, DiscoveredAgent } from './agents/discover'
import { PtyManager, shellHomeCwd } from './agents/process-manager'
import { ApprovalBridgeWatcher, writeDecision } from './agents/approval-bridge'
import type { AgentId } from '../shared/contracts'
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

/** User-dragged anchor. null = first launch centered near top. */
let windowAnchor: { x: number; y: number } | null = null

function getIslandBounds(width: number, height: number) {
  const display = screen.getDisplayNearestPoint(
    windowAnchor
      ? { x: windowAnchor.x + Math.floor(width / 2), y: windowAnchor.y + 8 }
      : screen.getCursorScreenPoint()
  )
  const { x: ox, y: oy, width: sw, height: sh } = display.workArea
  let x = windowAnchor?.x ?? Math.round(ox + (sw - width) / 2)
  let y = windowAnchor?.y ?? Math.round(oy + 12)
  x = Math.min(Math.max(ox, x), Math.max(ox, ox + sw - width))
  y = Math.min(Math.max(oy, y), Math.max(oy, oy + sh - height))
  return { x, y, width, height }
}

function rememberWindowPosition(): void {
  if (!mainWindow) return
  const b = mainWindow.getBounds()
  windowAnchor = { x: b.x, y: b.y }
}

function createWindow(): void {
  const initial = getIslandBounds(236, 48)
  const preloadPath = join(__dirname, '../preload/index.js')
  if (!existsSync(preloadPath)) {
    console.error('Missing preload script:', preloadPath)
  }

  mainWindow = new BrowserWindow({
      ...initial,
      frame: false,
      // Solid window — Windows transparent layers paint a white/gray plate
      // behind rounded CSS. OS roundedCorners shapes the pill instead.
      transparent: false,
      alwaysOnTop: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: false,
      hasShadow: true,
      thickFrame: false,
      roundedCorners: true,
      backgroundColor: '#0c0c10',
      title: 'Agent Island',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })

    mainWindow.setBackgroundColor('#0c0c10')
    mainWindow.setAlwaysOnTop(true, 'screen-saver')
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
    mainWindow.on('moved', () => rememberWindowPosition())

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function resizeIsland(width: number, height: number): void {
  if (!mainWindow) return
  const bounds = getIslandBounds(width, height)
  mainWindow.setBounds(bounds, true)
}

function agentFromDiscovery(agentId: AgentId): DiscoveredAgent | undefined {
  return discoveryCache?.agents.find((a) => a.id === agentId)
}

function registerIpc(): void {
  ipcMain.handle('island:resize', (_event, width: number, height: number) => {
    if (
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 120 ||
      width > 1200 ||
      height < 48 ||
      height > 900
    ) {
      throw new Error('Invalid island size')
    }
    resizeIsland(Math.round(width), Math.round(height))
    return true
  })

  ipcMain.handle('island:set-position', (_event, x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid position')
    windowAnchor = { x: Math.round(x), y: Math.round(y) }
    if (!mainWindow) return false
    const b = mainWindow.getBounds()
    mainWindow.setBounds(
      { x: windowAnchor.x, y: windowAnchor.y, width: b.width, height: b.height },
      false
    )
    return true
  })

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
    if (request.data.length > MAX_PTY_WRITE_CHARS) return { ok: false, error: 'Write payload too large' }
    return ptyManager.write(request.agentId, request.data)
  })
  ipcMain.handle('pty:resize', (_event, request: PtyResizeRequest) => {
    if (!request || !isAgentId(request.agentId)) return { ok: false, error: 'Invalid resize request' }
    return ptyManager.resize(request.agentId, request.cols, request.rows)
  })
  ipcMain.handle('pty:stop', async (_event, request: PtyStopRequest) => {
    if (!request || !isAgentId(request.agentId)) return { ok: false, error: 'Invalid stop request' }
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
