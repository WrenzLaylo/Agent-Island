import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { discoverAgents } from './agents/discover'
import type { AgentDiscoveryResult } from './agents/discover'

let mainWindow: BrowserWindow | null = null
let discoveryCache: AgentDiscoveryResult | null = null

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

  ipcMain.handle('island:quit', () => {
    app.quit()
  })
}

app.whenReady().then(async () => {
  registerIpc()
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

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
