/**
 * Background updates.
 *
 * Deliberately quiet. This app is an overlay whose whole job is to interrupt
 * the user at the right moment; an update that interrupts them at the wrong
 * one would undermine the only thing it does. So:
 *
 *  - no dialogs, ever — the tray entry is the entire interface;
 *  - the download happens on its own, but installing waits for the user;
 *  - a restart is refused while any prompt is on screen (`canRestartForUpdate`);
 *  - failures are silent beyond the tray label, because a failed update check
 *    is not the user's problem and a popup about it certainly is not.
 *
 * `autoInstallOnAppQuit` means a downloaded update lands the next time the app
 * closes even if the user never chooses to restart, so nothing is required of
 * them for this to work.
 */
import { app } from 'electron'
import type { UpdateState } from '../shared/update-safety'
import { canRestartForUpdate } from '../shared/update-safety'

/** Re-check this often while the app stays open. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Wait before the first check so it never competes with startup work. */
const FIRST_CHECK_DELAY_MS = 30_000

type Listener = (state: UpdateState) => void

let state: UpdateState = { stage: 'idle' }
let listeners: Listener[] = []
let timer: NodeJS.Timeout | null = null
let started = false

/** Loaded lazily: requiring it in a dev run pulls in a module that cannot work. */
type AutoUpdater = typeof import('electron-updater').autoUpdater
let updater: AutoUpdater | null = null

function setState(next: UpdateState): void {
  state = next
  for (const listener of listeners) listener(state)
}

export function getUpdateState(): UpdateState {
  return state
}

export function onUpdateStateChanged(listener: Listener): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((entry) => entry !== listener)
  }
}

function loadUpdater(): AutoUpdater | null {
  if (updater) return updater
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('electron-updater') as typeof import('electron-updater')
    updater = mod.autoUpdater
    return updater
  } catch {
    return null
  }
}

export function initUpdater(): void {
  if (started) return
  started = true

  /*
   * An unpackaged run has no update feed and no installer to apply, and
   * electron-updater throws rather than no-oping. The tray says so instead of
   * offering an action that cannot work.
   */
  if (!app.isPackaged) {
    setState({ stage: 'unsupported' })
    return
  }

  const auto = loadUpdater()
  if (!auto) {
    setState({ stage: 'unsupported' })
    return
  }

  auto.autoDownload = true
  auto.autoInstallOnAppQuit = true

  auto.on('checking-for-update', () => setState({ stage: 'checking' }))
  auto.on('update-available', (info) => setState({ stage: 'available', version: info?.version }))
  auto.on('update-not-available', () => setState({ stage: 'idle' }))
  auto.on('download-progress', (progress) =>
    setState({ stage: 'downloading', version: state.version, percent: progress?.percent ?? 0 })
  )
  auto.on('update-downloaded', (info) => setState({ stage: 'ready', version: info?.version }))
  auto.on('error', (error) => {
    // Being offline is the common case and is not worth reporting loudly.
    setState({ stage: 'error', message: String(error?.message ?? error) })
  })

  setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY_MS)
  timer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS)
  timer.unref?.()
}

export async function checkForUpdates(): Promise<void> {
  const auto = loadUpdater()
  if (!auto || !app.isPackaged) return
  // Nothing to do once a build is sitting ready to install.
  if (state.stage === 'downloading' || state.stage === 'ready') return
  try {
    await auto.checkForUpdates()
  } catch (error) {
    setState({ stage: 'error', message: String(error) })
  }
}

/**
 * Apply a downloaded update, unless someone is mid-decision.
 *
 * Returns the refusal so the caller can say why rather than appearing to
 * ignore the click.
 */
export function applyUpdate(counts: { pendingApprovals: number; terminalPrompts: number }):
  | { ok: true }
  | { ok: false; reason: string } {
  const auto = loadUpdater()
  if (!auto || state.stage !== 'ready') {
    return { ok: false, reason: 'No update is ready yet' }
  }

  const verdict = canRestartForUpdate(counts)
  if (!verdict.ok) return { ok: false, reason: verdict.reason ?? 'Not now' }

  // `isSilent: false` so the installer's own progress is visible; the second
  // argument reopens the app afterwards.
  auto.quitAndInstall(false, true)
  return { ok: true }
}

export function stopUpdater(): void {
  if (timer) clearInterval(timer)
  timer = null
  listeners = []
}
