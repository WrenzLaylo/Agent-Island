import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Install and version the Hermes bridge plugin.
 *
 * Hermes is the one agent that offers a structured approval channel rather
 * than a terminal to read, and that channel was verified working end to end.
 * Nothing in this app ever installed it. Shell integration installed the
 * wrapper and the shims and stopped there, so a clean machine got terminal
 * parsing only — while the README claimed Hermes was structured by default.
 *
 * The plugin the app carries is the source of truth. An older copy on disk is
 * replaced rather than merged: a bridge is a protocol, and half of one is
 * worse than none.
 */

const PLUGIN_NAME = 'agent-island-bridge'

/** The copy shipped with the app. */
export function bundledPluginDir(): string {
  return join(app.getAppPath(), 'plugins', PLUGIN_NAME)
}

/**
 * Where Hermes loads plugins from.
 *
 * Sibling of the agent install rather than inside it, so a Hermes upgrade
 * does not remove the bridge.
 */
export function installedPluginDir(): string {
  const local = process.env.LOCALAPPDATA
  const base = local && local.length > 0 ? local : join(homedir(), 'AppData', 'Local')
  return join(base, 'hermes', 'plugins', PLUGIN_NAME)
}

/** Read `version:` out of a plugin.yaml without pulling in a YAML parser. */
function readVersion(dir: string): string | null {
  try {
    const raw = readFileSync(join(dir, 'plugin.yaml'), 'utf8')
    const match = /^\s*version:\s*(.+?)\s*$/m.exec(raw)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

export interface HermesBridgeStatus {
  bundledVersion: string | null
  installedVersion: string | null
  installed: boolean
  /** True when the installed copy matches what this build carries. */
  current: boolean
  installedPath: string
  /**
   * Hermes loads plugins once, at startup. An install or update reaches only
   * sessions started afterwards, so the UI has to say so rather than implying
   * the change is live.
   */
  restartRequired: boolean
}

/**
 * Derived from disk every time, never remembered.
 *
 * A remembered flag goes stale the moment the user upgrades Hermes, clears
 * the directory, or copies a plugin in by hand — all of which happened here
 * before this existed.
 */
export function hermesBridgeStatus(): HermesBridgeStatus {
  const installedPath = installedPluginDir()
  const bundledVersion = readVersion(bundledPluginDir())
  const installedVersion = readVersion(installedPath)
  const installed = installedVersion !== null
  const current = installed && bundledVersion !== null && installedVersion === bundledVersion
  return {
    bundledVersion,
    installedVersion,
    installed,
    current,
    installedPath,
    restartRequired: installed && !current
  }
}

export interface HermesBridgeInstallResult {
  ok: boolean
  status: HermesBridgeStatus
  copied: string[]
  errors: string[]
}

/**
 * Copy the bundled plugin into place, replacing whatever is there.
 *
 * Deliberately not recursive: the plugin is two files at the top level, and a
 * blind recursive copy would drag along `__pycache__` from the source tree,
 * which is stale bytecode for a different Python than the user's.
 */
export function installHermesBridge(): HermesBridgeInstallResult {
  const errors: string[] = []
  const copied: string[] = []
  const source = bundledPluginDir()
  const target = installedPluginDir()

  if (!existsSync(source)) {
    return {
      ok: false,
      status: hermesBridgeStatus(),
      copied,
      errors: [`Bundled bridge plugin not found at ${source}`]
    }
  }

  try {
    mkdirSync(target, { recursive: true })
    /*
     * Drop bytecode compiled from the version being replaced.
     *
     * Python invalidates a .pyc by source mtime, and copying updates that, so
     * this is not strictly required. It is removed anyway because stale
     * bytecode from a previous version is precisely what produces "I updated
     * it and it is still running the old code" — a confusion far more
     * expensive than the directory it costs to delete.
     */
    rmSync(join(target, '__pycache__'), { recursive: true, force: true })
    for (const name of readdirSync(source)) {
      const from = join(source, name)
      if (!statSync(from).isFile()) continue
      if (name.endsWith('.pyc')) continue
      copyFileSync(from, join(target, name))
      copied.push(name)
    }
  } catch (error) {
    errors.push(String(error))
  }

  const status = hermesBridgeStatus()
  return { ok: errors.length === 0 && status.installed, status, copied, errors }
}
