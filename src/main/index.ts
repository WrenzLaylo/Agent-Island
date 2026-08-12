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
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { discoverAgents } from './agents/discover'
import type { AgentDiscoveryResult, DiscoveredAgent } from './agents/discover'
import { SessionWatcher } from './agents/session-watcher'
import { ensureRegistryDirs, focusDir } from '../node/registry-paths'
import type { AgentSessionRecord } from '../shared/session-registry'
import { ApprovalBridgeWatcher, writeDecision } from './agents/approval-bridge'
import { hermesBridgeStatus, installHermesBridge } from './agents/hermes-bridge'
import {
  ensureLauncherScripts,
  installShellShims,
  removeShellShims,
  shimStatus
} from './agents/shell-shims'
import { focusTabByTitle, foregroundWindow, getWindowRect, raiseWindow } from '../node/win32-windows'
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
import { tuckedBounds, tuckSideFor } from '../shared/tuck'
import { loginItemTarget, supportsLoginItem } from './login-item'
import { applyUpdate, checkForUpdates, getUpdateState, initUpdater, onUpdateStateChanged } from './updater'
import { canRestartForUpdate, updateMenuEnabled, updateMenuLabel } from '../shared/update-safety'
import {
  axisSettled,
  frameIntervalMs,
  moveDistance,
  omegaForDistance,
  stepSpringAxis,
  SPRING_SUB_STEP,
  type SpringAxis
} from '../shared/spring'

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
/** Parked off the screen edge; see `shared/tuck.ts`. */
let isTucked = false
let tuckedSide: DockSide | null = null
/** Where to put the island back when it untucks. */
let tuckReturn: { x: number; y: number } | null = null
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
  // Never persist an off-screen position: the island would launch already
  // hidden, with no visible way to bring it back.
  if (!mainWindow || isAnimatingBounds || isTucked) return
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
 * This is the *only* geometry animation in the app. The renderer no longer
 * springs the surface as well; it just cross-fades its contents, so the frame
 * the user sees is always exactly the OS window.
 *
 * The physics itself lives in `shared/spring.ts` so its tuning can be tested
 * without opening a window.
 */

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
  // One stiffness for the whole move, chosen from how far it travels. Per-axis
  // values would let width settle before height and skew the shape mid-morph.
  const omega = omegaForDistance(moveDistance(start, target))
  // Pace to the panel the window is actually on, and read the clock
  // monotonically: Date.now() can step sideways when the system clock is
  // corrected, which would inject a bogus dt into the integrator.
  const frameMs = frameIntervalMs(
    screen.getDisplayNearestPoint({ x: start.x + start.width / 2, y: start.y + start.height / 2 }).displayFrequency
  )
  let previous = Number(process.hrtime.bigint() / 1000n) / 1000

  return await new Promise<boolean>((resolve) => {
    const step = () => {
      if (!mainWindow || mainWindow.isDestroyed() || token !== boundsAnimationToken) {
        if (token === boundsAnimationToken) isAnimatingBounds = false
        resolve(false)
        return
      }

      const now = Number(process.hrtime.bigint() / 1000n) / 1000
      // Clamp so a stalled main process (GC, a slow IPC handler) replays at most
      // a tenth of a second of physics instead of teleporting the window.
      const frame = Math.min((now - previous) / 1000, 0.1)
      previous = now

      let remaining = frame
      while (remaining > 0) {
        const dt = Math.min(remaining, SPRING_SUB_STEP)
        for (const axis of axes) stepSpringAxis(axis, dt, omega)
        remaining -= dt
      }

      const settled = axes.every((axis) => axisSettled(axis, omega))
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
      setTimeout(step, frameMs)
    }
    setTimeout(step, 0)
  })
}

async function resizeIsland(width: number, height: number): Promise<boolean> {
  /*
   * A tucked island still changes size as its content changes. Re-running
   * `getIslandBounds` would clamp it back inside the work area and silently
   * untuck it, so the tucked position is recomputed for the new size instead.
   */
  if (isTucked && tuckedSide && mainWindow) {
    const area = displayForWindow(width, height).workArea
    const bounds = mainWindow.getBounds()
    return animateIslandTo(tuckedBounds({ ...bounds, width, height }, area, tuckedSide))
  }
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

/**
 * Slide the island off the edge, or bring it back.
 *
 * `windowAnchor` is left untouched while tucked, so returning restores exactly
 * where the user had put it. `saveCurrentLayout` is likewise skipped: writing
 * the off-screen position to disk would make the island launch already hidden,
 * with no visible way to get it back.
 */
async function setIslandTucked(next: boolean): Promise<boolean> {
  if (!mainWindow || next === isTucked) return false
  const bounds = mainWindow.getBounds()
  const area = displayForWindow(bounds.width, bounds.height).workArea

  if (next) {
    const side = tuckSideFor(bounds, area, dockSide)
    tuckReturn = { x: bounds.x, y: bounds.y }
    tuckedSide = side
    isTucked = true
    await animateIslandTo(tuckedBounds(bounds, area, side))
  } else {
    const home = tuckReturn
    isTucked = false
    tuckedSide = null
    tuckReturn = null
    if (home) {
      await animateIslandTo({ x: home.x, y: home.y, width: bounds.width, height: bounds.height })
    } else {
      await animateIslandTo(getIslandBounds(bounds.width, bounds.height))
    }
  }
  mainWindow?.webContents.send('island:tucked-changed', isTucked)
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

/**
 * Register or remove the login item, and report whether it took.
 *
 * Returns the state Windows actually holds afterwards rather than the state
 * that was asked for, so a refused write surfaces instead of leaving the tray
 * checkbox claiming something untrue.
 */
function applyLaunchAtStartup(enabled: boolean): boolean {
  if (!supportsLoginItem(process.platform)) return false
  const target = loginItemTarget(app.isPackaged, process.execPath, app.getAppPath())
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, ...target })
    return app.getLoginItemSettings(target).openAtLogin
  } catch {
    // Locked-down machines can refuse the registry write outright.
    return false
  }
}

function applySettingsSideEffects(previous: IslandSettings, next: IslandSettings): void {
  if (previous.alwaysOnTop !== next.alwaysOnTop && mainWindow) {
    mainWindow.setAlwaysOnTop(next.alwaysOnTop, 'screen-saver')
  }
  if (previous.launchAtStartup !== next.launchAtStartup) {
    applyLaunchAtStartup(next.launchAtStartup)
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

/**
 * How many prompts are currently waiting on the user.
 *
 * Both sources count: a session prompt from a wrapper and a bridge approval
 * are equally "someone is mid-decision", and restarting under either is what
 * `canRestartForUpdate` exists to prevent.
 */
function pendingPromptCounts(): { pendingApprovals: number; terminalPrompts: number } {
  return {
    pendingApprovals: bridgeWatcher.list().length,
    terminalPrompts: sessionWatcher.listPrompts().length
  }
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
        /*
         * The whole update interface. No dialogs: this app exists to interrupt
         * the user at the right moment, and interrupting them at the wrong one
         * to talk about itself would undermine that.
         */
        label: updateMenuLabel(getUpdateState(), canRestartForUpdate(pendingPromptCounts())),
        enabled: updateMenuEnabled(getUpdateState(), canRestartForUpdate(pendingPromptCounts())),
        click: () => {
          if (getUpdateState().stage === 'ready') {
            // Already gated by `enabled`; the check inside applyUpdate is the
            // real guard, since the menu was built before this click.
            applyUpdate(pendingPromptCounts())
            return
          }
          void checkForUpdates()
        }
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
        // Discoverability for a state that is otherwise only reachable by
        // waiting: once tucked, the sliver is the only thing left to click.
        label: isTucked ? 'Bring back from edge' : 'Tuck to edge',
        click: () => {
          void setIslandTucked(!isTucked).then(rebuildTrayMenu)
        }
      },
      {
        label: 'Tuck automatically when idle',
        type: 'checkbox',
        checked: settings.autoTuckIdle,
        click: (item: { checked: boolean }) => updateAppSettings({ autoTuckIdle: item.checked })
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

  /*
   * Order matters more than total work here.
   *
   * Every Win32 and UI Automation call is a separate PowerShell process that
   * compiles inline C# or loads the automation assemblies — roughly 0.9s each,
   * measured. Tab focus additionally waits for the wrapper to paint its
   * marker. Doing all of that *before* the raise meant the window the user
   * asked for appeared last, 3-5 seconds after the click.
   *
   * The raise now goes first, so the terminal comes forward in about the time
   * of one call. Marking the tab is started beforehand but not awaited: the
   * marker only has to be painted by the time the UIA lookup runs, and the
   * raise itself covers that delay for free.
   */
  const marker = beginTabMarker(session)

  const area = islandDisplay().workArea
  const shouldMove = getSettings().moveTerminalToIsland && !(await windowIsOnDisplay(session.hwnd, area))

  const outcome = await raiseWindow({
    hwnd: session.hwnd,
    moveTo: shouldMove ? area : undefined
  })

  if (outcome === 'gone') {
    await marker.cancel()
    return { ok: false, error: 'That terminal has been closed.' }
  }
  if (outcome === 'error') {
    await marker.cancel()
    return { ok: false, error: 'The terminal window could not be raised.' }
  }

  // The window is already up, so the caller is not kept waiting on the tab.
  void marker.focus()
  return { ok: true }
}

/**
 * Ask the session to paint a marker in its tab title, so the right *tab* comes
 * forward and not merely the right window.
 *
 * Split into request and lookup so the caller can raise the window in between.
 * The wrapper polls for the request, and the raise takes long enough on its
 * own that the marker is painted by the time `focus()` runs — the fixed wait
 * this used to need is now covered by work that had to happen anyway.
 */
interface TabMarker {
  focus: () => Promise<void>
  cancel: () => Promise<void>
}

function beginTabMarker(session: AgentSessionRecord): TabMarker {
  const noop: TabMarker = { focus: async () => {}, cancel: async () => {} }
  if (session.hwnd == null || session.terminalKind !== 'windows-terminal') return noop

  const marker = `agent-island-focus-${randomUUID()}`
  const requestPath = join(focusDir(), `${session.id}.json`)
  try {
    ensureRegistryDirs()
    writeFileSync(
      requestPath,
      JSON.stringify({ sessionId: session.id, marker, requestedAt: Date.now() }, null, 2),
      'utf8'
    )
  } catch (error) {
    console.warn('Could not request a tab marker:', error)
    return noop
  }

  // Removing the request is what tells the wrapper to restore its title, so it
  // has to happen on every exit path.
  const clear = async () => {
    try {
      rmSync(requestPath, { force: true })
    } catch {
      // ignore
    }
  }

  return {
    focus: async () => {
      try {
        if (session.hwnd != null) await focusTabByTitle(session.hwnd, marker)
      } catch (error) {
        console.warn('Could not focus the session tab:', error)
      } finally {
        await clear()
      }
    },
    cancel: clear
  }
}

async function windowIsOnDisplay(
  hwnd: number,
  area: { x: number; y: number; width: number; height: number }
): Promise<boolean> {
  // With a single display the answer cannot be anything but yes, and asking
  // costs a PowerShell process — about 0.9s, measured — on the click path of
  // every handoff for the great majority of machines.
  if (screen.getAllDisplays().length <= 1) return true

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
    mainWindow.webContents.send('island:window-focus', false)
    mainWindow.webContents.send('island:outside-click')
  })
  mainWindow.on('focus', () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    mainWindow.webContents.send('island:window-focus', true)
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
    showIsland()
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

  ipcMain.handle('island:set-tucked', (_event: unknown, value: unknown) => setIslandTucked(value === true))
  ipcMain.handle('island:is-tucked', () => isTucked)
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
    (
      _event: unknown,
      request: {
        sessionId?: unknown
        promptId?: unknown
        decision?: unknown
        optionIndex?: unknown
        text?: unknown
      }
    ) => {
      if (
        !request ||
        typeof request.sessionId !== 'string' ||
        typeof request.promptId !== 'string'
      ) {
        return { ok: false, error: 'Invalid decision' }
      }
      const hasChoice = isApprovalDecision(request.decision)
      const hasIndex =
        typeof request.optionIndex === 'number' && Number.isFinite(request.optionIndex)
      const hasText = typeof request.text === 'string' && request.text.trim().length > 0
      /*
       * At least one answer form, and never a mix of kinds.
       *
       * `optionIndex` + `choice` together is the one permitted pair: both come
       * from the same detection so they cannot disagree, and sending both is
       * what lets a newer island still drive a wrapper that predates the
       * optionIndex protocol. Free text with either of them would be a real
       * ambiguity, and is refused.
       */
      if (!hasChoice && !hasIndex && !hasText) {
        return { ok: false, error: 'Invalid decision' }
      }
      if (hasText && (hasChoice || hasIndex)) {
        return { ok: false, error: 'Invalid decision' }
      }
      const ok = sessionWatcher.writeDecision({
        sessionId: request.sessionId,
        promptId: request.promptId,
        choice: hasChoice ? (request.decision as ApprovalDecision) : undefined,
        optionIndex: hasIndex ? Math.trunc(request.optionIndex as number) : undefined,
        text: hasText ? (request.text as string) : undefined,
        decidedAt: Date.now()
      })
      return ok ? { ok: true } : { ok: false, error: 'The decision could not be written.' }
    }
  )
  ipcMain.handle('island:install-shims', () => installShellShims())
  ipcMain.handle('island:uninstall-shims', () => removeShellShims())
  ipcMain.handle('island:shim-status', () => shimStatus())
  ipcMain.handle('island:hermes-bridge-status', () => hermesBridgeStatus())
  ipcMain.handle('island:install-hermes-bridge', () => installHermesBridge())

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
    showIsland()
    mainWindow?.webContents.send('island:approval', request)
  })
  bridgeWatcher.on('cleared', (request) => {
    mainWindow?.webContents.send('island:approval-cleared', request)
  })
}

function wireSessionEvents(): void {
  sessionWatcher.on('prompt-raised', (prompt, session) => {
    void (async () => {
      // If the user is already looking at the terminal that raised this, the
      // island has nothing to add — the prompt is right in front of them, and
      // popping open over it is pure nuisance. Stay collapsed and let the pill
      // carry the state instead.
      const fg = session.hwnd == null ? null : await foregroundWindow()
      const terminalFocused = fg != null && fg === session.hwnd

      // Never take focus for a prompt. The user is very likely typing
      // somewhere, and stealing the keyboard to announce something they can
      // read at a glance costs them their cursor position. Collapse-on-click
      // no longer depends on this: the idle retract handles an island nobody
      // is using.
      if (!terminalFocused) showIsland()
      mainWindow?.webContents.send('island:session-prompt', { prompt, session, terminalFocused })
    })()
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
 * One-shot CLI commands run without contending for the single-instance lock:
 * they do a little filesystem work and exit, and refusing them while the island
 * happens to be open would make them useless exactly when you want them.
 */
const SHIM_COMMANDS = ['--install-shims', '--remove-shims', '--shim-status', '--bridge-status']
const shimCommand = process.argv.find((arg) => SHIM_COMMANDS.includes(arg))

/**
 * Two copies of Agent Island share one userData directory, one settings file,
 * one session registry and one set of global shortcuts, so a second launch
 * surfaces the existing island instead of starting a rival one.
 */
const hasInstanceLock = shimCommand ? true : app.requestSingleInstanceLock()

if (!hasInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  showIsland({ focus: true })
})

/**
 * `--install-shims` / `--remove-shims` / `--shim-status`, so shell integration
 * can be managed without the GUI — useful for scripted setup, and for checking
 * what is actually on disk when the island reports something unexpected.
 */
async function runShimCommand(command: string): Promise<void> {
  loadPersistedStore()
  ensureLauncherScripts()
  if (command === '--bridge-status') {
    process.stdout.write(`${JSON.stringify(hermesBridgeStatus(), null, 2)}\n`)
  } else if (command === '--shim-status') {
    // The bridge is part of "is integration set up?", so it is reported here
    // rather than needing a separate command to discover it is missing.
    const status = { ...shimStatus(), hermesBridge: hermesBridgeStatus() }
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
  } else if (command === '--install-shims') {
    /*
     * Installing shell integration now installs the Hermes bridge too.
     *
     * They were separate, so a clean machine got the wrapper and the shims
     * and no bridge at all - Hermes silently fell back to terminal parsing
     * while the README said it was structured. Setting up integration should
     * mean setting up integration.
     */
    const result = { ...installShellShims(), hermesBridge: installHermesBridge() }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`${JSON.stringify(removeShellShims(), null, 2)}\n`)
  }
  app.exit(0)
}

async function bootstrap(): Promise<void> {
  if (shimCommand) {
    await runShimCommand(shimCommand)
    return
  }

  loadPersistedStore()
  // Regenerate `island` / `island.cmd` on every launch so the command exists
  // (and points at the current install) whether or not shell integration is on.
  try {
    ensureLauncherScripts()
  } catch (error) {
    console.warn('Could not write the island launcher scripts:', error)
  }
  registerIpc()
  wireBridgeEvents()
  wireSessionEvents()
  sessionWatcher.start()
  void bridgeWatcher.start()
  discoveryCache = await discoverAgents()
  createWindow()
  createTray()

  initUpdater()
  // The tray label is the only surface for update state, so it has to follow it.
  onUpdateStateChanged(() => rebuildTrayMenu())

  /*
   * Re-apply on every launch so the registry entry follows the app if the
   * repository moves: the unpackaged entry embeds an absolute path, and a
   * stale one would start Electron's placeholder app at login instead.
   *
   * If the write is refused, the stored setting is corrected rather than left
   * claiming a login item that does not exist.
   */
  const settings = getSettings()
  if (supportsLoginItem(process.platform)) {
    const actual = applyLaunchAtStartup(settings.launchAtStartup)
    if (actual !== settings.launchAtStartup) updateSettings({ launchAtStartup: actual })
  }

  globalShortcut.register('Control+Alt+Space', () => {
    // Opening the island by shortcut is a deliberate act, so it takes focus.
    // Without that it would open unfocused and the idle-retract below would
    // immediately close it again.
    showIsland({ focus: true })
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
