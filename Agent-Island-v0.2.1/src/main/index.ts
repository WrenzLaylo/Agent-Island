import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray
} from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { discoverAgents } from './agents/discover'
import type { AgentDiscoveryResult, DiscoveredAgent } from './agents/discover'
import { PtyManager, shellHomeCwd } from './agents/process-manager'
import { ApprovalBridgeWatcher, writeDecision } from './agents/approval-bridge'
import {
  getDisplayLayout,
  getSettings,
  loadPersistedStore,
  saveDisplayLayout,
  updateSettings
} from './settings'
import type {
  AgentId,
  ApprovalDecision,
  DockSide,
  IslandSettings,
  IslandWindowLayout
} from '../shared/contracts'
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
let tray: Tray | null = null
let discoveryCache: AgentDiscoveryResult | null = null
const ptyManager = new PtyManager({ defaultCwd: shellHomeCwd(), forceKillMs: 1500 })
const bridgeWatcher = new ApprovalBridgeWatcher()

const isDev = !app.isPackaged
const EDGE_GAP = 8
const DOCK_THRESHOLD = 30
const HOME_TOP_GAP = 12
const HOME_SNAP_VERTICAL = 64
const HOME_SNAP_HORIZONTAL = 150
const WINDOW_SHAPE_INSET = 5
const APPROVAL_DECISIONS: ApprovalDecision[] = ['once', 'session', 'always', 'deny']
const TRAY_ICON =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA8UlEQVR4nO2WQQ6CMBBFq3FPIyuvw9YuZeUd9CweohthOWw5jq5IegNcSBP4mRZEqyT2JZNmBtL5/CYdhIhEIv/OaspLRDXNbaBUpnzPN1MaH4+H/VwBdg+XEKcDRDW90xjRuqw4EetvNBfi6eKkoySqKUm2bT/atr3ZgPrVBtRPNnAvFME60MeY5s7lxjQF1ItuPUN9kCMDASGsR/AoRh0IzagAKdMdl0uZ5lDPu/UC9UGOeO8BlwhsytS9Tfss6wiUypTWZRWyIV5Iy3JAiLAucNcx60AIEa5Z4B3Hn5iG9kNenoackDmM/Q9EIpGf8wB9Tpiv0CRbHgAAAABJRU5ErkJggg=='

/** User-dragged anchor. null = first launch uses a stored display layout or top-centre. */
let windowAnchor: { x: number; y: number } | null = null
let dockSide: DockSide | null = null
let boundsAnimationToken = 0
let isAnimatingBounds = false

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return APPROVAL_DECISIONS.includes(value as ApprovalDecision)
}

interface ShapeRect {
  x: number
  y: number
  width: number
  height: number
}

type ShapeCapableWindow = BrowserWindow & {
  setShape?: (rectangles: ShapeRect[]) => void
}

function roundedWindowShape(width: number, height: number): ShapeRect[] {
  const x0 = WINDOW_SHAPE_INSET
  const y0 = WINDOW_SHAPE_INSET
  const innerWidth = Math.max(1, width - WINDOW_SHAPE_INSET * 2)
  const innerHeight = Math.max(1, height - WINDOW_SHAPE_INSET * 2)
  const panelRadius = innerHeight <= 82 ? Math.floor(innerHeight / 2) : 25
  const radius = Math.max(1, Math.min(panelRadius, Math.floor(innerHeight / 2)))
  const rows: ShapeRect[] = []

  for (let y = 0; y < innerHeight; y += 1) {
    let inset = 0
    if (y < radius) {
      const dy = radius - y - 0.5
      inset = Math.ceil(radius - Math.sqrt(Math.max(0, radius * radius - dy * dy)))
    } else if (y >= innerHeight - radius) {
      const dy = y - (innerHeight - radius) + 0.5
      inset = Math.ceil(radius - Math.sqrt(Math.max(0, radius * radius - dy * dy)))
    }

    const row: ShapeRect = {
      x: x0 + inset,
      y: y0 + y,
      width: Math.max(1, innerWidth - inset * 2),
      height: 1
    }
    const previous = rows.at(-1)
    if (
      previous &&
      previous.x === row.x &&
      previous.width === row.width &&
      previous.y + previous.height === row.y
    ) {
      previous.height += 1
    } else {
      rows.push(row)
    }
  }

  return rows
}

function applyWindowShape(width: number, height: number): void {
  if (!mainWindow || process.platform === 'darwin') return
  const win = mainWindow as ShapeCapableWindow
  try {
    win.setShape?.(roundedWindowShape(width, height))
  } catch (error) {
    console.warn('Unable to apply native island shape:', error)
  }
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

function restoreInitialLayout(width: number, height: number): void {
  if (windowAnchor) return
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const saved = getDisplayLayout(display.id)
  const area = display.workArea

  if (saved) {
    dockSide = saved.docked
    const x = Math.round(area.x + saved.xRatio * Math.max(0, area.width - width))
    const y = Math.round(area.y + saved.yRatio * Math.max(0, area.height - height))
    windowAnchor = { x, y }
    return
  }

  const preferred = getSettings().preferredDockSide
  if (preferred !== 'none') dockSide = preferred
}

function getIslandBounds(width: number, height: number) {
  restoreInitialLayout(width, height)
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
    y = current.y <= oy + 28 ? current.y : Math.round(centreY - height / 2)
  } else {
    x = windowAnchor?.x ?? Math.round(ox + (sw - width) / 2)
    y = windowAnchor?.y ?? Math.round(oy + 12)
  }

  x = clamp(x, ox, Math.max(ox, ox + sw - width))
  y = clamp(y, oy, Math.max(oy, oy + sh - height))
  return { x, y, width, height }
}

function saveCurrentLayout(): void {
  if (!mainWindow || isAnimatingBounds) return
  const bounds = mainWindow.getBounds()
  windowAnchor = { x: bounds.x, y: bounds.y }
  const display = screen.getDisplayNearestPoint({
    x: bounds.x + Math.floor(bounds.width / 2),
    y: bounds.y + Math.floor(bounds.height / 2)
  })
  const area = display.workArea
  const xRange = Math.max(1, area.width - bounds.width)
  const yRange = Math.max(1, area.height - bounds.height)
  saveDisplayLayout(display.id, {
    docked: dockSide,
    xRatio: clamp((bounds.x - area.x) / xRange, 0, 1),
    yRatio: clamp((bounds.y - area.y) / yRange, 0, 1)
  })
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function cancelBoundsAnimation(): void {
  boundsAnimationToken += 1
  isAnimatingBounds = false
}

interface IslandBounds {
  x: number
  y: number
  width: number
  height: number
}

async function animateIslandTo(target: IslandBounds, preferredDuration?: number): Promise<boolean> {
  if (!mainWindow) return false
  const start = mainWindow.getBounds()
  const settings = getSettings()
  const duration = settings.reducedMotion
    ? 0
    : preferredDuration ?? (target.height > start.height ? 290 : 235)
  const token = ++boundsAnimationToken

  if (duration === 0) {
    mainWindow.setBounds(target, false)
    applyWindowShape(target.width, target.height)
    windowAnchor = { x: target.x, y: target.y }
    saveCurrentLayout()
    return true
  }

  isAnimatingBounds = true
  const started = Date.now()

  return await new Promise<boolean>((resolve) => {
    const step = () => {
      if (!mainWindow || token !== boundsAnimationToken) {
        isAnimatingBounds = false
        resolve(false)
        return
      }

      const progress = clamp((Date.now() - started) / duration, 0, 1)
      const eased = easeInOutCubic(progress)
      const next = {
        x: Math.round(start.x + (target.x - start.x) * eased),
        y: Math.round(start.y + (target.y - start.y) * eased),
        width: Math.round(start.width + (target.width - start.width) * eased),
        height: Math.round(start.height + (target.height - start.height) * eased)
      }
      mainWindow.setBounds(next, false)
      applyWindowShape(next.width, next.height)

      if (progress >= 1) {
        isAnimatingBounds = false
        windowAnchor = { x: target.x, y: target.y }
        saveCurrentLayout()
        resolve(true)
        return
      }
      setTimeout(step, 16)
    }
    step()
  })
}

async function resizeIsland(width: number, height: number): Promise<boolean> {
  return animateIslandTo(getIslandBounds(width, height))
}

function homeBounds(width: number, height: number): IslandBounds {
  const display = displayForWindow(width, height)
  const area = display.workArea
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + HOME_TOP_GAP,
    width,
    height
  }
}

async function returnIslandHome(notifyRenderer = true): Promise<IslandWindowLayout> {
  if (!mainWindow) return currentLayout()
  showIsland()
  dockSide = null
  const bounds = mainWindow.getBounds()
  await animateIslandTo(homeBounds(bounds.width, bounds.height), 320)
  if (notifyRenderer) mainWindow.webContents.send('island:return-home')
  return currentLayout()
}

function moveIsland(x: number, y: number): boolean {
  if (!mainWindow || !Number.isFinite(x) || !Number.isFinite(y)) return false
  cancelBoundsAnimation()

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

function currentLayout(): IslandWindowLayout {
  return {
    docked: dockSide,
    bounds: mainWindow?.getBounds() ?? null
  }
}

async function finishIslandDrag(): Promise<IslandWindowLayout> {
  if (!mainWindow) return currentLayout()

  const bounds = mainWindow.getBounds()
  const display = screen.getDisplayNearestPoint({
    x: bounds.x + Math.floor(bounds.width / 2),
    y: bounds.y + Math.floor(bounds.height / 2)
  })
  const area = display.workArea
  const leftDistance = Math.abs(bounds.x - area.x)
  const rightDistance = Math.abs(area.x + area.width - (bounds.x + bounds.width))
  const centreDistance = Math.abs(bounds.x + bounds.width / 2 - (area.x + area.width / 2))
  const topDistance = Math.abs(bounds.y - (area.y + HOME_TOP_GAP))

  if (centreDistance <= HOME_SNAP_HORIZONTAL && topDistance <= HOME_SNAP_VERTICAL) {
    return returnIslandHome()
  }

  if (leftDistance <= DOCK_THRESHOLD || rightDistance <= DOCK_THRESHOLD) {
    dockSide = leftDistance <= rightDistance ? 'left' : 'right'
    await animateIslandTo(getIslandBounds(bounds.width, bounds.height), 210)
  } else {
    dockSide = null
    saveCurrentLayout()
  }

  return currentLayout()
}

function applySettingsSideEffects(previous: IslandSettings, next: IslandSettings): void {
  if (previous.alwaysOnTop !== next.alwaysOnTop && mainWindow) {
    mainWindow.setAlwaysOnTop(next.alwaysOnTop, 'screen-saver')
  }
  if (previous.launchAtStartup !== next.launchAtStartup && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: next.launchAtStartup })
  }
  if (previous.preferredDockSide !== next.preferredDockSide && next.preferredDockSide !== 'none') {
    dockSide = next.preferredDockSide
    const bounds = mainWindow?.getBounds()
    if (bounds && mainWindow) {
      const snapped = getIslandBounds(bounds.width, bounds.height)
      mainWindow.setBounds(snapped, false)
      applyWindowShape(snapped.width, snapped.height)
      saveCurrentLayout()
    }
  }
  rebuildTrayMenu()
  mainWindow?.webContents.send('island:settings-changed', next)
}

function updateAppSettings(patch: Partial<IslandSettings>): IslandSettings {
  const previous = getSettings()
  const next = updateSettings(patch)
  applySettingsSideEffects(previous, next)
  return next
}

function showIsland(): void {
  if (!mainWindow) return
  mainWindow.showInactive()
  mainWindow.moveTop()
}

function showSettingsPanel(): void {
  showIsland()
  mainWindow?.webContents.send('island:open-settings')
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON}`).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('Agent Island')
  tray.on('click', () => {
    if (!mainWindow) return
    if (mainWindow.isVisible()) mainWindow.hide()
    else showIsland()
  })
  rebuildTrayMenu()
}

function rebuildTrayMenu(): void {
  if (!tray) return
  const settings = getSettings()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Agent Island', click: showIsland },
      { label: 'Settings…', click: showSettingsPanel },
      {
        label: 'Return to top centre',
        accelerator: 'CommandOrControl+Alt+Home',
        click: () => void returnIslandHome()
      },
      { type: 'separator' },
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: settings.alwaysOnTop,
        click: (item: { checked: boolean }) => updateAppSettings({ alwaysOnTop: item.checked })
      },
      {
        label: 'Launch at startup',
        type: 'checkbox',
        checked: settings.launchAtStartup,
        click: (item: { checked: boolean }) => updateAppSettings({ launchAtStartup: item.checked })
      },
      {
        label: 'Auto-expand approvals',
        type: 'checkbox',
        checked: settings.autoExpandApprovals,
        click: (item: { checked: boolean }) => updateAppSettings({ autoExpandApprovals: item.checked })
      },
      {
        label: 'Approval sounds',
        type: 'checkbox',
        checked: settings.approvalSounds,
        click: (item: { checked: boolean }) => updateAppSettings({ approvalSounds: item.checked })
      },
      {
        label: 'Quiet idle pill',
        type: 'checkbox',
        checked: settings.quietIdle,
        click: (item: { checked: boolean }) => updateAppSettings({ quietIdle: item.checked })
      },
      {
        label: 'Reduced motion',
        type: 'checkbox',
        checked: settings.reducedMotion,
        click: (item: { checked: boolean }) => updateAppSettings({ reducedMotion: item.checked })
      },
      {
        label: 'Preferred dock side',
        submenu: [
          {
            label: 'None',
            type: 'radio',
            checked: settings.preferredDockSide === 'none',
            click: () => updateAppSettings({ preferredDockSide: 'none' })
          },
          {
            label: 'Left',
            type: 'radio',
            checked: settings.preferredDockSide === 'left',
            click: () => updateAppSettings({ preferredDockSide: 'left' })
          },
          {
            label: 'Right',
            type: 'radio',
            checked: settings.preferredDockSide === 'right',
            click: () => updateAppSettings({ preferredDockSide: 'right' })
          }
        ]
      },
      {
        label: 'Developer diagnostics',
        type: 'checkbox',
        checked: settings.developerDiagnostics,
        click: (item: { checked: boolean }) => updateAppSettings({ developerDiagnostics: item.checked })
      },
      { type: 'separator' },
      { label: 'Quit Agent Island', click: () => app.quit() }
    ])
  )
}

function createWindow(): void {
  const initial = getIslandBounds(128, 48)
  const preloadPath = join(__dirname, '../preload/index.js')
  if (!existsSync(preloadPath)) console.error('Missing preload script:', preloadPath)
  const settings = getSettings()

  mainWindow = new BrowserWindow({
    ...initial,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: settings.alwaysOnTop,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    backgroundColor: '#00000000',
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
  mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver')
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
  mainWindow.on('moved', () => saveCurrentLayout())

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    applyWindowShape(initial.width, initial.height)
    mainWindow?.showInactive()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function agentFromDiscovery(agentId: AgentId): DiscoveredAgent | undefined {
  return discoveryCache?.agents.find((agent) => agent.id === agentId)
}

function registerIpc(): void {
  ipcMain.handle('island:resize', async (_event: unknown, width: number, height: number) => {
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
    return await resizeIsland(Math.round(width), Math.round(height))
  })

  ipcMain.on('island:move-window', (_event: unknown, x: number, y: number) => {
    moveIsland(x, y)
  })

  ipcMain.handle('island:set-position', (_event: unknown, x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid position')
    return moveIsland(x, y)
  })

  ipcMain.handle('island:finish-drag', () => finishIslandDrag())
  ipcMain.handle('island:return-home', () => returnIslandHome(false))
  ipcMain.handle('island:get-layout', () => currentLayout())
  ipcMain.handle('island:get-bounds', () => mainWindow?.getBounds() ?? null)
  ipcMain.handle('island:get-settings', () => getSettings())
  ipcMain.handle('island:update-settings', (_event: unknown, patch: Partial<IslandSettings>) => updateAppSettings(patch ?? {}))

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

  ipcMain.handle('pty:start', (_event: unknown, request: PtyStartRequest) => {
    if (!request || !isAgentId(request.agentId)) return { ok: false, error: 'Invalid agentId' }
    const sizeError = validateSize(request.cols, request.rows)
    if (sizeError) return { ok: false, error: sizeError }
    const agent = agentFromDiscovery(request.agentId)
    return ptyManager.start(request.agentId, agent, request.cols, request.rows, request.cwd)
  })
  ipcMain.handle('pty:write', (_event: unknown, request: PtyWriteRequest) => {
    if (!request || !isAgentId(request.agentId) || typeof request.data !== 'string') {
      return { ok: false, error: 'Invalid write request' }
    }
    if (request.data.length > MAX_PTY_WRITE_CHARS) return { ok: false, error: 'Write payload too large' }
    return ptyManager.write(request.agentId, request.data)
  })
  ipcMain.handle('pty:resize', (_event: unknown, request: PtyResizeRequest) => {
    if (!request || !isAgentId(request.agentId)) return { ok: false, error: 'Invalid resize request' }
    return ptyManager.resize(request.agentId, request.cols, request.rows)
  })
  ipcMain.handle('pty:stop', async (_event: unknown, request: PtyStopRequest) => {
    if (!request || !isAgentId(request.agentId)) return { ok: false, error: 'Invalid stop request' }
    return ptyManager.stop(request.agentId, Boolean(request.force))
  })
  ipcMain.handle('pty:list', () => ptyManager.list())
  ipcMain.handle('pty:replay', (_event: unknown, agentId: unknown) => {
    if (!isAgentId(agentId)) return ''
    return ptyManager.getReplay(agentId)
  })
  ipcMain.handle(
    'pty:answer-approval',
    (_event: unknown, request: { agentId?: unknown; requestId?: unknown; decision?: unknown }) => {
      if (
        !request ||
        !isAgentId(request.agentId) ||
        typeof request.requestId !== 'string' ||
        !isApprovalDecision(request.decision)
      ) {
        return { ok: false, error: 'Invalid approval decision' }
      }
      return ptyManager.answerApproval(request.agentId, request.requestId, request.decision)
    }
  )

  ipcMain.handle('bridge:list-approvals', () => bridgeWatcher.list())
  ipcMain.handle(
    'bridge:answer-approval',
    async (_event: unknown, request: { requestId?: unknown; decision?: unknown }) => {
      if (!request || typeof request.requestId !== 'string') return { ok: false, error: 'Invalid request' }
      if (!isApprovalDecision(request.decision)) return { ok: false, error: 'Invalid decision' }
      const pending = bridgeWatcher.list().find((item) => item.id === request.requestId)
      if (!pending) return { ok: false, error: 'Approval request is no longer pending' }
      if (pending.choices?.length && !pending.choices.includes(request.decision)) {
        return { ok: false, error: 'That permission option is not available for this request' }
      }
      try {
        await writeDecision(request.requestId, request.decision)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}

function wireBridgeEvents(): void {
  bridgeWatcher.on('raised', (request) => {
    showIsland()
    mainWindow?.webContents.send('island:approval', request)
  })
  bridgeWatcher.on('cleared', (request) => {
    mainWindow?.webContents.send('island:approval-cleared', request)
  })
}

function wirePtyEvents(): void {
  ptyManager.on('data', (payload) => mainWindow?.webContents.send('pty:data', payload))
  ptyManager.on('exit', (payload) => mainWindow?.webContents.send('pty:exit', payload))
  ptyManager.on('session', (payload) => mainWindow?.webContents.send('pty:session', payload))
  ptyManager.on('approval', (request) => {
    showIsland()
    mainWindow?.webContents.send('island:approval', request)
  })
  ptyManager.on('approval-cleared', (request) => {
    mainWindow?.webContents.send('island:approval-cleared', request)
  })
  ptyManager.on('approval-answered', (payload) => {
    mainWindow?.webContents.send('island:approval-answered', payload)
  })
}

app.whenReady().then(async () => {
  loadPersistedStore()
  registerIpc()
  wireBridgeEvents()
  wirePtyEvents()
  void bridgeWatcher.start()
  discoveryCache = await discoverAgents()
  createWindow()
  createTray()

  const settings = getSettings()
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.launchAtStartup })

  globalShortcut.register('Control+Alt+Space', () => {
    mainWindow?.webContents.send('island:toggle')
  })

  globalShortcut.register('CommandOrControl+Alt+Home', () => {
    void returnIslandHome()
  })

  screen.on('display-metrics-changed', () => {
    const bounds = mainWindow?.getBounds()
    if (!bounds || !mainWindow) return
    const next = getIslandBounds(bounds.width, bounds.height)
    mainWindow.setBounds(next, false)
    applyWindowShape(next.width, next.height)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showIsland()
  })
})

let isQuitting = false

app.on('before-quit', (event: { preventDefault(): void }) => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  globalShortcut.unregisterAll()
  tray?.destroy()
  tray = null
  bridgeWatcher.stop()
  void ptyManager.stopAll().finally(() => app.exit(0))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
