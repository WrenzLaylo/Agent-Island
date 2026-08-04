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
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    return first
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
  const candidates = [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.local', 'bin', 'claude.exe'),
    join(home, 'AppData', 'Local', 'Claude', 'claude.exe')
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
  const candidates = [
    join(home, '.local', 'bin', 'codex'),
    join(home, '.local', 'bin', 'codex.exe'),
    join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
    join(home, 'AppData', 'Local', 'Programs', 'codex', 'codex.exe')
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
    integrationMode: 'terminal-basic',
    notes: 'Codex CLI ready for ConPTY terminal session'
  }
}

async function resolveHermes(): Promise<DiscoveredAgent> {
  const home = homedir()
  const candidates = [
    join(home, 'AppData', 'Local', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
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
