import { describe, expect, it } from 'vitest'
import {
  canRestartForUpdate,
  updateMenuEnabled,
  updateMenuLabel,
  type UpdateState
} from '../../src/shared/update-safety'

const READY: UpdateState = { stage: 'ready', version: '0.5.0' }

describe('restarting for an update', () => {
  it('allows a restart when nothing is waiting', () => {
    expect(canRestartForUpdate({ pendingApprovals: 0, terminalPrompts: 0 })).toEqual({ ok: true })
  })

  it('refuses while an approval is on screen', () => {
    /*
     * The one thing a restart can actually cost. A card vanishing mid-read is
     * indistinguishable from a crash, and clicking where the button was is
     * exactly how an approval gets answered by accident.
     */
    const verdict = canRestartForUpdate({ pendingApprovals: 1, terminalPrompts: 0 })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('An agent is waiting on an answer')
  })

  it('refuses for a terminal prompt too', () => {
    // A handoff prompt is just as much a decision in progress.
    expect(canRestartForUpdate({ pendingApprovals: 0, terminalPrompts: 1 }).ok).toBe(false)
  })

  it('counts both sources together', () => {
    const verdict = canRestartForUpdate({ pendingApprovals: 2, terminalPrompts: 1 })
    expect(verdict.reason).toBe('3 agents are waiting on an answer')
  })

  it('ignores nonsense counts rather than blocking forever', () => {
    // A negative count should not read as "something is waiting".
    expect(canRestartForUpdate({ pendingApprovals: -1, terminalPrompts: 0 }).ok).toBe(true)
  })
})

describe('tray label', () => {
  it('states the reason instead of failing silently on click', () => {
    const blocked = canRestartForUpdate({ pendingApprovals: 1, terminalPrompts: 0 })
    expect(updateMenuLabel(READY, blocked)).toBe(
      'Update 0.5.0 ready — An agent is waiting on an answer'
    )
    expect(updateMenuEnabled(READY, blocked)).toBe(false)
  })

  it('offers the restart when it is safe', () => {
    expect(updateMenuLabel(READY, { ok: true })).toBe('Restart to update to 0.5.0')
    expect(updateMenuEnabled(READY, { ok: true })).toBe(true)
  })

  it('shows progress while downloading, and stays inert', () => {
    const state: UpdateState = { stage: 'downloading', version: '0.5.0', percent: 41.7 }
    expect(updateMenuLabel(state)).toBe('Downloading 0.5.0… 42%')
    expect(updateMenuEnabled(state)).toBe(false)
  })

  it('says plainly that a dev run cannot update', () => {
    // Offering an action that cannot work is worse than admitting it.
    const state: UpdateState = { stage: 'unsupported' }
    expect(updateMenuLabel(state)).toBe('Updates (installed builds only)')
    expect(updateMenuEnabled(state)).toBe(false)
  })

  it('lets a failed check be retried', () => {
    const state: UpdateState = { stage: 'error', message: 'getaddrinfo ENOTFOUND' }
    expect(updateMenuLabel(state)).toBe('Update check failed — retry')
    expect(updateMenuEnabled(state)).toBe(true)
  })

  it('offers a check when idle', () => {
    expect(updateMenuLabel({ stage: 'idle' })).toBe('Check for updates…')
  })

  it('does not claim a version it does not know', () => {
    expect(updateMenuLabel({ stage: 'ready' })).toBe('Restart to update to the new version')
  })
})
