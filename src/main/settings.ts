import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_ISLAND_SETTINGS,
  type AgentId,
  type DockSide,
  type IslandSettings,
  type PreferredDockSide
} from '../shared/contracts'

export interface SavedDisplayLayout {
  docked: DockSide | null
  xRatio: number
  yRatio: number
}

interface PersistedStore {
  settings: IslandSettings
  displays: Record<string, SavedDisplayLayout>
}

let state: PersistedStore = {
  settings: { ...DEFAULT_ISLAND_SETTINGS },
  displays: {}
}

function storePath(): string {
  return join(app.getPath('userData'), 'agent-island-settings.json')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function isAgentId(value: unknown): value is AgentId {
  return value === 'claude' || value === 'codex' || value === 'hermes'
}

function isPreferredDock(value: unknown): value is PreferredDockSide {
  return value === 'none' || value === 'left' || value === 'right'
}

function sanitiseSettings(value: Partial<IslandSettings> | undefined): IslandSettings {
  const raw = value ?? {}
  return {
    launchAtStartup:
      typeof raw.launchAtStartup === 'boolean'
        ? raw.launchAtStartup
        : DEFAULT_ISLAND_SETTINGS.launchAtStartup,
    alwaysOnTop:
      typeof raw.alwaysOnTop === 'boolean' ? raw.alwaysOnTop : DEFAULT_ISLAND_SETTINGS.alwaysOnTop,
    autoExpandApprovals:
      typeof raw.autoExpandApprovals === 'boolean'
        ? raw.autoExpandApprovals
        : DEFAULT_ISLAND_SETTINGS.autoExpandApprovals,
    autoCollapseMs:
      typeof raw.autoCollapseMs === 'number' && Number.isFinite(raw.autoCollapseMs)
        ? Math.round(clamp(raw.autoCollapseMs, 500, 5000))
        : DEFAULT_ISLAND_SETTINGS.autoCollapseMs,
    preferredDockSide: isPreferredDock(raw.preferredDockSide)
      ? raw.preferredDockSide
      : DEFAULT_ISLAND_SETTINGS.preferredDockSide,
    reducedMotion:
      typeof raw.reducedMotion === 'boolean'
        ? raw.reducedMotion
        : DEFAULT_ISLAND_SETTINGS.reducedMotion,
    approvalSounds:
      typeof raw.approvalSounds === 'boolean'
        ? raw.approvalSounds
        : DEFAULT_ISLAND_SETTINGS.approvalSounds,
    rememberLastAgent:
      typeof raw.rememberLastAgent === 'boolean'
        ? raw.rememberLastAgent
        : DEFAULT_ISLAND_SETTINGS.rememberLastAgent,
    lastAgentId: isAgentId(raw.lastAgentId) ? raw.lastAgentId : DEFAULT_ISLAND_SETTINGS.lastAgentId,
    glassIntensity:
      typeof raw.glassIntensity === 'number' && Number.isFinite(raw.glassIntensity)
        ? clamp(raw.glassIntensity, 0.45, 0.92)
        : DEFAULT_ISLAND_SETTINGS.glassIntensity,
    quietIdle:
      typeof raw.quietIdle === 'boolean'
        ? raw.quietIdle
        : DEFAULT_ISLAND_SETTINGS.quietIdle,
    developerDiagnostics:
      typeof raw.developerDiagnostics === 'boolean'
        ? raw.developerDiagnostics
        : DEFAULT_ISLAND_SETTINGS.developerDiagnostics,
    onboardingComplete:
      typeof raw.onboardingComplete === 'boolean'
        ? raw.onboardingComplete
        : DEFAULT_ISLAND_SETTINGS.onboardingComplete,
    moveTerminalToIsland:
      typeof raw.moveTerminalToIsland === 'boolean'
        ? raw.moveTerminalToIsland
        : DEFAULT_ISLAND_SETTINGS.moveTerminalToIsland
  }
}

function sanitiseDisplay(value: Partial<SavedDisplayLayout>): SavedDisplayLayout | null {
  if (!Number.isFinite(value.xRatio) || !Number.isFinite(value.yRatio)) return null
  const docked = value.docked === 'left' || value.docked === 'right' ? value.docked : null
  return {
    docked,
    xRatio: clamp(Number(value.xRatio), 0, 1),
    yRatio: clamp(Number(value.yRatio), 0, 1)
  }
}

let persistTimer: NodeJS.Timeout | null = null

function persistNow(): void {
  persistTimer = null
  try {
    const target = storePath()
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, target)
  } catch (error) {
    // Losing a layout write is survivable; crashing the main process is not.
    console.warn('Unable to persist Agent Island settings:', error)
  }
}

/**
 * Coalesced write. Layout is saved from the window's `moved` event, which fires
 * once per drag frame — persisting synchronously there meant a writeFileSync +
 * renameSync on the main thread ~60 times a second while the user dragged.
 */
function persist(immediate = false): void {
  if (immediate) {
    if (persistTimer) clearTimeout(persistTimer)
    persistNow()
    return
  }
  if (persistTimer) return
  persistTimer = setTimeout(persistNow, 400)
}

/** Flush any coalesced write before the process exits. */
export function flushPersistedStore(): void {
  if (persistTimer) persistNow()
}

export function loadPersistedStore(): PersistedStore {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), 'utf8')) as Partial<PersistedStore>
    const displays: Record<string, SavedDisplayLayout> = {}
    for (const [id, value] of Object.entries(parsed.displays ?? {})) {
      const clean = sanitiseDisplay(value)
      if (clean) displays[id] = clean
    }
    state = {
      settings: sanitiseSettings(parsed.settings),
      displays
    }
  } catch {
    state = {
      settings: { ...DEFAULT_ISLAND_SETTINGS },
      displays: {}
    }
  }
  return getPersistedStore()
}

export function getPersistedStore(): PersistedStore {
  return {
    settings: { ...state.settings },
    displays: { ...state.displays }
  }
}

export function getSettings(): IslandSettings {
  return { ...state.settings }
}

export function updateSettings(patch: Partial<IslandSettings>): IslandSettings {
  state.settings = sanitiseSettings({ ...state.settings, ...patch })
  // Explicit user choices are written straight through; only layout is coalesced.
  persist(true)
  return getSettings()
}

export function getDisplayLayout(displayId: string | number): SavedDisplayLayout | undefined {
  const layout = state.displays[String(displayId)]
  return layout ? { ...layout } : undefined
}

export function saveDisplayLayout(displayId: string | number, layout: SavedDisplayLayout): void {
  const clean = sanitiseDisplay(layout)
  if (!clean) return
  const key = String(displayId)
  const previous = state.displays[key]
  if (
    previous &&
    previous.docked === clean.docked &&
    previous.xRatio === clean.xRatio &&
    previous.yRatio === clean.yRatio
  ) {
    return
  }
  state.displays[key] = clean
  persist()
}
