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
import { SessionWatcher } from './agents/session-watcher'
import { ApprovalBridgeWatcher, writeDecision } from './agents/approval-bridge'
import { installShellShims, removeShellShims, shimStatus } from './agents/shell-shims'
import { getWindowRect, raiseWindow } from '../node/win32-windows'
import {
  flushPersistedStore,
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
  IslandWindowLayout,
  TerminalInputPrompt
} from '../shared/contracts'
import { isAgentId } from '../shared/pty-types'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let discoveryCache: AgentDiscoveryResult | null = null
const sessionWatcher = new SessionWatcher()
const bridgeWatcher = new ApprovalBridgeWatcher()

const isDev = !app.isPackaged
const EDGE_GAP = 8
const DOCK_THRESHOLD = 64
const DOCK_ZONE_WIDTH = 96
const HOME_TOP_GAP = 12
const HOME_SNAP_VERTICAL = 64
const HOME_SNAP_HORIZONTAL = 150
const MIN_ISLAND_WIDTH = 32
const MIN_ISLAND_HEIGHT = 32
const MAX_ISLAND_WIDTH = 1200
const MAX_ISLAND_HEIGHT = 900
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

/**
 * The island's silhouette is drawn by CSS `border-radius` on a transparent,
 * per-pixel-alpha window. Earlier versions also clipped the native HWND with
 * `BrowserWindow.setShape()`; that region is a list of 1px scanlines with no
 * anti-aliasing, so it re-cut every rounded corner into a hard staircase and
 * fought the (correctly anti-aliased) CSS radius underneath it. The shape only
 * existed to hide a `backdrop-filter` artefact that no longer applies — the
 * surface is opaque black now — so there is no native mask any more.
 */

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

/**
 * Critically damped spring, integrated at a fixed sub-step so the result is
 * identical regardless of how late a frame lands. `zeta = 1` means it settles
 * without overshoot, which is what a morphing container should do — an
 * under-damped spring makes the pill look like it bounces off its own edges.
 *
 * This is the *only* geometry animation in the app. The renderer no longer
 * springs the surface as well; it just cross-fades its contents, so the frame
 * the user sees is always exactly the OS window.
 */
const SPRING_OMEGA = 22
const SPRING_SUB_STEP = 1 / 240
/** Snap once within a pixel: the last pixel takes as long as the first fifty. */
const SPRING_EPSILON = 0.9

interface SpringAxis {
  value: number
  velocity: number
  target: number
}

function stepSpringAxis(axis: SpringAxis, dt: number): void {
  const displacement = axis.value - axis.target
  const acceleration = -SPRING_OMEGA * SPRING_OMEGA * displacement - 2 * SPRING_OMEGA * axis.velocity
  axis.velocity += acceleration * dt
  axis.value += axis.velocity * dt
}

function axisSettled(axis: SpringAxis): boolean {
  return Math.abs(axis.value - axis.target) < SPRING_EPSILON && Math.abs(axis.velocity) < SPRING_EPSILON * SPRING_OMEGA
}

async function animateIslandTo(target: IslandBounds): Promise<boolean> {
  if (!mainWindow) return false
  const start = mainWindow.getBounds()
  const token = ++boundsAnimationToken

  const unchanged =
    start.x === target.x &&
    start.y === target.y &&
    start.width === target.width &&
    start.height === target.height

  if (unchanged || getSettings().reducedMotion) {
    mainWindow.setBounds(target, false)
    windowAnchor = { x: target.x, y: target.y }
    saveCurrentLayout()
    return true
  }

  isAnimatingBounds = true
  const axes: SpringAxis[] = [
    { value: start.x, velocity: 0, target: target.x },
    { value: start.y, velocity: 0, target: target.y },
    { value: start.width, velocity: 0, target: target.width },
    { value: start.height, velocity: 0, target: target.height }
  ]
  let previous = Date.now()

  return await new Promise<boolean>((resolve) => {
    const step = () => {
      if (!mainWindow || mainWindow.isDestroyed() || token !== boundsAnimationToken) {
        if (token === boundsAnimationToken) isAnimatingBounds = false
        resolve(false)
        return
      }

      const now = Date.now()
      // Clamp so a stalled main process (GC, a slow IPC handler) replays at most
      // a tenth of a second of physics instead of teleporting the window.
      const frame = Math.min((now - previous) / 1000, 0.1)
      previous = now

      let remaining = frame
      while (remaining > 0) {
        const dt = Math.min(remaining, SPRING_SUB_STEP)
        for (const axis of axes) stepSpringAxis(axis, dt)
        remaining -= dt
      }

      const settled = axes.every(axisSettled)
      const next = settled
        ? target
        : {
            x: Math.round(axes[0].value),
            y: Math.round(axes[1].value),
            width: Math.round(axes[2].value),
            height: Math.round(axes[3].value)
          }
      mainWindow.setBounds(next, false)

      if (settled) {
        isAnimatingBounds = false
        windowAnchor = { x: target.x, y: target.y }
        saveCurrentLayout()
        resolve(true)
        return
      }
      setTimeout(step, 8)
    }
    setTimeout(step, 0)
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
  await animateIslandTo(homeBounds(bounds.width, bounds.height))
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
  const centreX = bounds.x + bounds.width / 2
  const leftZoneHit = centreX <= area.x + DOCK_ZONE_WIDTH
  const rightZoneHit = centreX >= area.x + area.width - DOCK_ZONE_WIDTH

  if (centreDistance <= HOME_SNAP_HORIZONTAL && topDistance <= HOME_SNAP_VERTICAL) {
    return returnIslandHome()
  }

  if (leftDistance <= DOCK_THRESHOLD || rightDistance <= DOCK_THRESHOLD || leftZoneHit || rightZoneHit) {
    if (leftZoneHit && !rightZoneHit) {
      dockSide = 'left'
    } else if (rightZoneHit && !leftZoneHit) {
      dockSide = 'right'
    } else {
      dockSide = leftDistance <= rightDistance ? 'left' : 'right'
    }
    await animateIslandTo(getIslandBounds(bounds.width, bounds.height))
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
      void animateIslandTo(getIslandBounds(bounds.width, bounds.height))
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

/**
 * `focus` is not cosmetic. "Click outside to collapse" is driven by the
 * window's `blur` event, and a window that never held focus never blurs — so
 * anything raised with `showInactive()` alone (an approval arriving while you
 * work in your editor) used to expand and then ignore every click elsewhere on
 * screen. Anything that demands a decision takes focus so that dismissing it
 * works; ambient state changes stay inactive and out of the way.
 */
function showIsland(options: { focus?: boolean } = {}): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (options.focus) {
    mainWindow.show()
    mainWindow.focus()
  } else {
    mainWindow.showInactive()
  }
  mainWindow.moveTop()
}

function showSettingsPanel(): void {
  showIsland({ focus: true })
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
      { label: 'Open Agent Island', click: () => showIsland({ focus: true }) },
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

function sendToRenderer(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}

function islandDisplay() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds()
    return screen.getDisplayNearestPoint({
      x: bounds.x + Math.floor(bounds.width / 2),
      y: bounds.y + Math.floor(bounds.height / 2)
    })
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

/**
 * Bring the terminal that is actually hosting this agent session to the front.
 *
 * This raises a window Agent Island does not own and never created: the HWND
 * was published by the `island` wrapper running inside the user's real
 * terminal. Nothing is launched here — if the window is gone, the session is
 * gone, and the caller is told so.
 */
async function handoffToTerminal(
  agentId: AgentId,
  sessionId?: string
): Promise<{ ok: boolean; error?: string }> {
  const session = sessionId
    ? sessionWatcher.getSession(sessionId)
    : sessionWatcher.newestSessionFor(agentId)

  if (!session) {
    return {
      ok: false,
      error: `No live ${agentId} session. Start one with "island ${agentId}" in a terminal.`
    }
  }
  if (session.hwnd == null) {
    return {
      ok: false,
      error: `${session.terminalLabel} does not expose a window that can be raised. Switch to it manually.`
    }
  }

  const area = islandDisplay().workArea
  // Only relocate when the terminal is on a different display, and only when
  // the user has not opted out of having their layout rearranged.
  const shouldMove =
    getSettings().moveTerminalToIsland && !(await windowIsOnDisplay(session.hwnd, area))

  const outcome = await raiseWindow({
    hwnd: session.hwnd,
    moveTo: shouldMove ? area : undefined
  })

  if (outcome === 'gone') {
    return { ok: false, error: 'That terminal has been closed.' }
  }
  if (outcome === 'error') {
    return { ok: false, error: 'The terminal window could not be raised.' }
  }
  return { ok: true }
}

async function windowIsOnDisplay(
  hwnd: number,
  area: { x: number; y: number; width: number; height: number }
): Promise<boolean> {
  const rect = await getWindowRect(hwnd)
  if (!rect) return false
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return cx >= area.x && cx <= area.x + area.width && cy >= area.y && cy <= area.y + area.height
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
  mainWindow.on('blur', () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    mainWindow.webContents.send('island:outside-click')
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    // Approvals that were already pending when the app launched are restored by
    // the renderer, not by a `raised` event, so they would otherwise open an
    // expanded panel on a window that has never held focus — and "click outside
    // to collapse" rides on `blur`.
    const restoringApproval = bridgeWatcher.list().length > 0 && getSettings().autoExpandApprovals
    showIsland({ focus: restoringApproval })
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
      width < MIN_ISLAND_WIDTH ||
      width > MAX_ISLAND_WIDTH ||
      height < MIN_ISLAND_HEIGHT ||
      height > MAX_ISLAND_HEIGHT
    ) {
      throw new Error(`Invalid island size: ${String(width)}×${String(height)} (allowed ${MIN_ISLAND_WIDTH}–${MAX_ISLAND_WIDTH} × ${MIN_ISLAND_HEIGHT}–${MAX_ISLAND_HEIGHT})`)
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
  ipcMain.handle(
    'terminal:handoff',
    (_event: unknown, request: { agentId?: unknown; sessionId?: unknown }) => {
      if (!request || !isAgentId(request.agentId)) return { ok: false, error: 'Invalid agentId' }
      if (request.sessionId != null && typeof request.sessionId !== 'string') {
        return { ok: false, error: 'Invalid sessionId' }
      }
      const sessionId = typeof request.sessionId === 'string' ? request.sessionId : undefined
      return handoffToTerminal(request.agentId, sessionId)
    }
  )

  ipcMain.handle('island:list-sessions', () => sessionWatcher.listSessions())
  ipcMain.handle('island:list-session-prompts', () => sessionWatcher.listPrompts())
  ipcMain.handle(
    'island:answer-session-prompt',
    (_event: unknown, request: { sessionId?: unknown; promptId?: unknown; decision?: unknown }) => {
      if (
        !request ||
        typeof request.sessionId !== 'string' ||
        typeof request.promptId !== 'string' ||
        !isApprovalDecision(request.decision)
      ) {
        return { ok: false, error: 'Invalid decision' }
      }
      const ok = sessionWatcher.writeDecision({
        sessionId: request.sessionId,
        promptId: request.promptId,
        choice: request.decision,
        decidedAt: Date.now()
      })
      return ok ? { ok: true } : { ok: false, error: 'The decision could not be written.' }
    }
  )
  ipcMain.handle('island:install-shims', () => installShellShims())
  ipcMain.handle('island:uninstall-shims', () => removeShellShims())
  ipcMain.handle('island:shim-status', () => shimStatus())

  ipcMain.handle('island:discover-agents', async () => {
    discoveryCache = await discoverAgents()
    return discoveryCache
  })
  ipcMain.handle('island:get-discovery', () => discoveryCache)

  ipcMain.handle('island:quit', () => {
    bridgeWatcher.stop()
    sessionWatcher.stop()
    app.quit()
  })

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
    // Only steal focus when the island is actually going to open in front of
    // the user; with auto-expand off it just updates a count in the pill.
    showIsland({ focus: getSettings().autoExpandApprovals })
    mainWindow?.webContents.send('island:approval', request)
  })
  bridgeWatcher.on('cleared', (request) => {
    mainWindow?.webContents.send('island:approval-cleared', request)
  })
}

function wireSessionEvents(): void {
  sessionWatcher.on('prompt-raised', (prompt, session) => {
    const focus = prompt.kind === 'handoff' || getSettings().autoExpandApprovals
    showIsland({ focus })
    mainWindow?.webContents.send('island:session-prompt', { prompt, session })
  })
  sessionWatcher.on('prompt-cleared', (prompt) => {
    mainWindow?.webContents.send('island:session-prompt-cleared', prompt)
  })
  sessionWatcher.on('session-added', (session) => {
    mainWindow?.webContents.send('island:session-added', session)
  })
  sessionWatcher.on('session-removed', (session) => {
    mainWindow?.webContents.send('island:session-removed', session)
  })
}

/**
 * Two copies of Agent Island share one userData directory, one settings file,
 * one session registry and one set of global shortcuts, so a second launch
 * surfaces the existing island instead of starting a rival one.
 */
const hasInstanceLock = app.requestSingleInstanceLock()

if (!hasInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  showIsland({ focus: true })
})

async function bootstrap(): Promise<void> {
  loadPersistedStore()
  registerIpc()
  wireBridgeEvents()
  wireSessionEvents()
  sessionWatcher.start()
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

  // Resolution changes, DPI changes and hot-plugged monitors can all leave the
  // island parked outside every work area. Re-clamp against whatever displays
  // exist now rather than trusting the stored anchor.
  const reconcileToDisplays = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    cancelBoundsAnimation()
    const bounds = mainWindow.getBounds()
    mainWindow.setBounds(getIslandBounds(bounds.width, bounds.height), false)
    saveCurrentLayout()
  }

  screen.on('display-metrics-changed', reconcileToDisplays)
  screen.on('display-added', reconcileToDisplays)
  screen.on('display-removed', reconcileToDisplays)

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    else showIsland()
  })
}

if (hasInstanceLock) {
  void app.whenReady().then(bootstrap)
}

let isQuitting = false

app.on('before-quit', (event: { preventDefault(): void }) => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  globalShortcut.unregisterAll()
  tray?.destroy()
  tray = null
  bridgeWatcher.stop()
  sessionWatcher.stop()
  flushPersistedStore()
  app.exit(0)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
