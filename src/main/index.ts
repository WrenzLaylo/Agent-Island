import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { discoverAgents } from './agents/discover'
import type { AgentDiscoveryResult, DiscoveredAgent } from './agents/discover'
import { PtyManager, shellHomeCwd } from './agents/process-manager'
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

const isDev = !app.isPackaged

function getIslandBounds(width: number, height: number) {
  const display = screen.getPrimaryDisplay()
  const { width: sw } = display.workAreaSize
  const { x, y } = display.workArea
  return {
    x: Math.round(x + (sw - width) / 2),
    y: Math.round(y + 12),
    width,
    height
  }
}

function createWindow(): void {
  const initial = getIslandBounds(420, 72)
  const preloadPath = join(__dirname, '../preload/index.js')
  if (!existsSync(preloadPath)) {
    console.error('Missing preload script:', preloadPath)
  }

  mainWindow = new BrowserWindow({
    ...initial,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'Agent Island',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })

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

  ipcMain.handle('island:discover-agents', async () => {
    discoveryCache = await discoverAgents()
    return discoveryCache
  })

  ipcMain.handle('island:get-discovery', () => discoveryCache)

  ipcMain.handle('island:quit', async () => {
    await ptyManager.stopAll()
    app.quit()
  })

  ipcMain.handle('pty:start', (_event, request: PtyStartRequest) => {
    if (!request || !isAgentId(request.agentId)) {
      return { ok: false, error: 'Invalid agentId' }
    }
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
}

function wirePtyEvents(): void {
  ptyManager.on('data', (event) => {
    mainWindow?.webContents.send('pty:data', event)
  })
  ptyManager.on('exit', (event) => {
    mainWindow?.webContents.send('pty:exit', event)
  })
}

app.whenReady().then(async () => {
  registerIpc()
  wirePtyEvents()
  discoveryCache = await discoverAgents()
  createWindow()

  globalShortcut.register('Control+Alt+Space', () => {
    mainWindow?.webContents.send('island:toggle')
  })
  globalShortcut.register('Control+Alt+1', () => {
    mainWindow?.webContents.send('island:select-agent', 'claude')
  })
  globalShortcut.register('Control+Alt+2', () => {
    mainWindow?.webContents.send('island:select-agent', 'codex')
  })
  globalShortcut.register('Control+Alt+3', () => {
    mainWindow?.webContents.send('island:select-agent', 'hermes')
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
  void ptyManager.stopAll().finally(() => {
    app.exit(0)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
