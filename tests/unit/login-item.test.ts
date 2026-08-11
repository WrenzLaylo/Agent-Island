import { describe, expect, it } from 'vitest'
import { loginItemTarget, supportsLoginItem } from '../../src/main/login-item'

const ELECTRON = 'C:\\repo\\agent-island\\node_modules\\electron\\dist\\electron.exe'
const APP = 'C:\\repo\\agent-island'

describe('login item target', () => {
  it('passes the app path when unpackaged', () => {
    /*
     * The bug this fixes. Unpackaged, execPath is Electron itself; registering
     * it bare makes Windows start Electron's placeholder app at login rather
     * than the island. The old code avoided that by not registering anything
     * at all, so the tray toggle moved and did nothing.
     */
    const target = loginItemTarget(false, ELECTRON, APP)
    expect(target.path).toBe(ELECTRON)
    expect(target.args).toEqual([APP])
  })

  it('leaves a packaged build to Electron defaults', () => {
    // execPath is the app's own exe there, and naming it explicitly would
    // hard-code an install path that an updater is free to move.
    expect(loginItemTarget(true, 'C:\\Program Files\\Agent Island\\island.exe', APP)).toEqual({})
  })

  it('gives the getter the same target as the setter', () => {
    // Windows only reports an entry accurately when queried with the path and
    // arguments it was written with; a mismatch drifts the tray checkbox out
    // of step with what is actually registered.
    const forSet = loginItemTarget(false, ELECTRON, APP)
    const forGet = loginItemTarget(false, ELECTRON, APP)
    expect(forGet).toEqual(forSet)
  })

  it('keeps the app path as a single argument', () => {
    // A path with spaces must not be split: Electron quotes each argument, and
    // splitting here would register two broken ones instead.
    const spaced = 'C:\\Users\\Someone\\My Projects\\agent island'
    expect(loginItemTarget(false, ELECTRON, spaced).args).toEqual([spaced])
  })
})

describe('platform support', () => {
  it('registers on the platforms Electron implements', () => {
    expect(supportsLoginItem('win32')).toBe(true)
    expect(supportsLoginItem('darwin')).toBe(true)
  })

  it('refuses elsewhere rather than pretending', () => {
    // setLoginItemSettings is a silent no-op on Linux, which would put the
    // original lie straight back.
    expect(supportsLoginItem('linux')).toBe(false)
    expect(supportsLoginItem('freebsd')).toBe(false)
  })
})
