/**
 * Start-at-login registration.
 *
 * `app.setLoginItemSettings({ openAtLogin })` registers `process.execPath`
 * with no arguments. For a packaged build that is exactly right: execPath is
 * the app's own exe.
 *
 * Unpackaged — which is how this is actually installed today, launched from
 * `node_modules/electron/dist/electron.exe` — execPath is Electron itself.
 * Registering it with no arguments makes Windows start Electron's default
 * placeholder app at login, not the island.
 *
 * The previous code sidestepped that by gating the whole thing on
 * `app.isPackaged`, which meant the tray toggle silently did nothing: the
 * setting persisted and the checkbox moved, so it looked like it had worked.
 * A control that lies is worse than one that is absent.
 */

export interface LoginItemTarget {
  /** Executable to register. Omitted when Electron's default is correct. */
  path?: string
  /** Arguments it needs to find the app. */
  args?: string[]
}

/*
 * A note on the registry value name, which is deliberately left alone.
 *
 * Unpackaged, Electron names the value after the executable, so the entry is
 * `electron.app.Electron` — shared by any Electron app launched from a raw
 * `electron.exe`, i.e. every other project in dev mode. Passing `name` to
 * `setLoginItemSettings` fixes that, and it was tried.
 *
 * It cannot be used. `LoginItemSettingsOptions` — the *getter* — has no `name`
 * field, so `getLoginItemSettings` could no longer find the renamed entry and
 * reported `openAtLogin: false` while the entry sat in the registry. The
 * startup reconciliation then "corrected" the stored setting to false, so the
 * toggle turned itself back off. Verified on this machine: with `name` set the
 * entry was written and the setting flipped to false; without it, both agree.
 *
 * A prettier key is not worth a control that lies, which is the bug this file
 * exists to fix. Packaging resolves it properly, since a packaged build has a
 * real AppUserModelId.
 */

/**
 * What to register at login.
 *
 * Returned as options for both `setLoginItemSettings` and
 * `getLoginItemSettings`: on Windows the getter only reports accurately when
 * given the same path and arguments the entry was written with, so the two
 * calls must agree or the tray checkbox drifts out of step with reality.
 */
export function loginItemTarget(
  isPackaged: boolean,
  execPath: string,
  appPath: string
): LoginItemTarget {
  if (isPackaged) return {}
  return { path: execPath, args: [appPath] }
}

/**
 * Whether this platform can register a login item at all.
 *
 * Electron implements `setLoginItemSettings` on Windows and macOS. Calling it
 * elsewhere is a silent no-op, which would put the lie straight back.
 */
export function supportsLoginItem(platform: string): boolean {
  return platform === 'win32' || platform === 'darwin'
}
