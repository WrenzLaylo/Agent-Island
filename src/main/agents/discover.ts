import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentId, IntegrationMode } from '../../shared/contracts'
import { mergeDiscoveryWithAdapter } from './launch'

const execFileAsync = promisify(execFile)

export interface DiscoveredAgent {
  id: AgentId
  label: string
  available: boolean
  path?: string
  version?: string
  integrationMode: IntegrationMode
  notes?: string
}

export interface AgentDiscoveryResult {
  discoveredAt: string
  agents: DiscoveredAgent[]
}

/** Windows executable extensions, most preferred first. */
const WINDOWS_EXEC_PRIORITY = ['.exe', '.cmd', '.bat', '.com']

/**
 * Choose the entry a Windows process can actually start.
 *
 * `where` lists every PATH match in PATH order, and npm installs a pair: an
 * extensionless shell script alongside a `.cmd`. Taking the first line handed
 * back the extensionless one, which CreateProcess cannot run — it fails with
 * ERROR_BAD_EXE_FORMAT (193). That is the whole of the "Could not start codex,
 * error code 193" report: the binary was fine, our choice of it was not.
 *
 * Extensionless entries are ranked last rather than discarded. On a machine
 * where the only match has no extension it may still be a real PE image, and
 * returning nothing would report the agent as missing — a worse answer than a
 * questionable one.
 */
export function pickExecutable(matches: string[], isWindows: boolean): string | undefined {
  if (!matches.length) return undefined
  if (!isWindows) return matches[0]

  const rank = (path: string): number => {
    const dot = path.lastIndexOf('.')
    const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf(String.fromCharCode(92)))
    const ext = dot > slash ? path.slice(dot).toLowerCase() : ''
    if (ext === '') return WINDOWS_EXEC_PRIORITY.length + 1
    const known = WINDOWS_EXEC_PRIORITY.indexOf(ext)
    return known >= 0 ? known : WINDOWS_EXEC_PRIORITY.length
  }

  // Stable: equal ranks keep PATH order, so the earliest .exe still wins.
  return matches
    .map((path, index) => ({ path, index, rank: rank(path) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)[0]?.path
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function which(command: string): Promise<string | undefined> {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execFileAsync(cmd, [command], {
      windowsHide: true,
      timeout: 5000
    })
    const matches = stdout
      .split(/\r?\n/)
      .map((line: string) => line.trim())
      .filter(Boolean)
    return pickExecutable(matches, process.platform === 'win32')
  } catch {
    return undefined
  }
}

async function tryVersion(path: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(path, args, {
      windowsHide: true,
      timeout: 8000
    })
    const text = `${stdout}\n${stderr}`.trim()
    const line = text.split(/\r?\n/).find((l) => l.trim())
    return line?.trim()
  } catch {
    return undefined
  }
}

async function resolveClaude(): Promise<DiscoveredAgent> {
  const home = homedir()
  // Runnable extensions first. These are tried in order, so listing the
  // extensionless shim ahead of the .exe picked the one that cannot start.
  const candidates = [
    join(home, 'AppData', 'Local', 'Claude', 'claude.exe'),
    join(home, '.local', 'bin', 'claude.exe'),
    join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    join(home, '.local', 'bin', 'claude')
  ]

  let found = await which('claude')
  if (!found) {
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        found = candidate
        break
      }
    }
  }

  if (!found) {
    return {
      id: 'claude',
      label: 'Claude',
      available: false,
      integrationMode: 'unavailable',
      notes: 'claude executable not found'
    }
  }

  const version = await tryVersion(found, ['--version'])
  return {
    id: 'claude',
    label: 'Claude',
    available: true,
    path: found,
    version,
    integrationMode: 'terminal-basic',
    notes: 'Claude Code ready for ConPTY terminal session'
  }
}

async function resolveCodex(): Promise<DiscoveredAgent> {
  const home = homedir()
  // Runnable extensions first, and the real installer location: Codex ships to
  // Programs/OpenAI/Codex/bin, which this list did not mention at all.
  const candidates = [
    join(home, 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    join(home, 'AppData', 'Local', 'Programs', 'codex', 'codex.exe'),
    join(home, '.local', 'bin', 'codex.exe'),
    join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
    join(home, '.local', 'bin', 'codex')
  ]

  let found = await which('codex')
  if (!found) {
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        found = candidate
        break
      }
    }
  }

  if (!found) {
    return {
      id: 'codex',
      label: 'Codex',
      available: false,
      integrationMode: 'unavailable',
      notes: 'codex executable not found in PATH or common locations'
    }
  }

  const version = await tryVersion(found, ['--version'])
  return {
    id: 'codex',
    label: 'Codex',
    available: true,
    path: found,
    version,
    integrationMode: 'terminal-known',
    notes: 'Codex CLI ready with terminal approval bridging'
  }
}

async function resolveHermes(): Promise<DiscoveredAgent> {
  const home = homedir()
  // Runnable extensions first, as above.
  const candidates = [
    join(home, 'AppData', 'Local', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
    join(home, '.local', 'bin', 'hermes.exe'),
    join(home, 'AppData', 'Local', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes'),
    join(home, '.local', 'bin', 'hermes')
  ]

  let found = await which('hermes')
  if (!found) {
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        found = candidate
        break
      }
    }
  }

  if (!found) {
    return {
      id: 'hermes',
      label: 'Hermes',
      available: false,
      integrationMode: 'unavailable',
      notes: 'hermes executable not found'
    }
  }

  const version = await tryVersion(found, ['--version'])
  return {
    id: 'hermes',
    label: 'Hermes',
    available: true,
    path: found,
    version,
    integrationMode: 'terminal-basic',
    notes: 'Hermes Agent ready for ConPTY terminal session'
  }
}

export async function discoverAgents(): Promise<AgentDiscoveryResult> {
  const raw = await Promise.all([resolveClaude(), resolveCodex(), resolveHermes()])
  const agents = raw.map(mergeDiscoveryWithAdapter)
  return {
    discoveredAt: new Date().toISOString(),
    agents
  }
}
