/**
 * When it is safe to restart for an update, and how to describe the state.
 *
 * Kept apart from `electron-updater` so the rules can be tested without a
 * network or a packaged build.
 */

export type UpdateStage =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export interface UpdateState {
  stage: UpdateStage
  version?: string
  /** 0–100 while downloading. */
  percent?: number
  message?: string
}

export interface RestartVerdict {
  ok: boolean
  /** Why not, phrased for a menu item. */
  reason?: string
}

/**
 * Whether the app may restart itself right now.
 *
 * Restarting is unusually cheap here — agent sessions are separate wrapper
 * processes and their prompts live in files, so a prompt raised during the
 * restart is still there afterwards. Nothing is lost by waiting, and nothing
 * is lost by restarting either, with one exception.
 *
 * That exception is a decision the user is in the middle of. A card vanishing
 * mid-read is indistinguishable from a crash, and the natural reaction — click
 * where the button was — is exactly how an approval gets answered by accident.
 * So a pending prompt of any kind blocks the restart, and the update simply
 * waits; `autoInstallOnAppQuit` means it lands next time the app closes even
 * if the user never chooses it.
 */
export function canRestartForUpdate(input: {
  pendingApprovals: number
  terminalPrompts: number
}): RestartVerdict {
  const waiting = Math.max(0, input.pendingApprovals) + Math.max(0, input.terminalPrompts)
  if (waiting > 0) {
    return {
      ok: false,
      reason: waiting === 1 ? 'An agent is waiting on an answer' : `${waiting} agents are waiting on an answer`
    }
  }
  return { ok: true }
}

/**
 * Tray label for the current state.
 *
 * When an update is ready but cannot be applied, the reason goes in the label
 * rather than into a message after the click. Saying why up front is both
 * simpler — no notification channel to build — and better: the user sees the
 * constraint before acting instead of being told their action was ignored.
 */
export function updateMenuLabel(state: UpdateState, restart: RestartVerdict = { ok: true }): string {
  const version = state.version ?? 'update'
  switch (state.stage) {
    case 'unsupported':
      return 'Updates (installed builds only)'
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Downloading ${version}…`
    case 'downloading':
      return `Downloading ${version}… ${Math.round(state.percent ?? 0)}%`
    case 'ready':
      return restart.ok
        ? `Restart to update to ${state.version ?? 'the new version'}`
        : `Update ${version} ready — ${restart.reason}`
    case 'error':
      return 'Update check failed — retry'
    default:
      return 'Check for updates…'
  }
}

/** Whether clicking the tray entry should do anything. */
export function updateMenuEnabled(state: UpdateState, restart: RestartVerdict = { ok: true }): boolean {
  if (state.stage === 'unsupported' || state.stage === 'checking' || state.stage === 'downloading') {
    return false
  }
  // A ready update that would interrupt a decision is shown, but inert.
  if (state.stage === 'ready') return restart.ok
  return true
}
