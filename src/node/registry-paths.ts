/**
 * Filesystem layout for the session registry. Lives outside `src/shared`
 * because that directory is also type-checked for the renderer, which has no
 * `node:*` types.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function registryRoot(): string {
  const local = process.env.LOCALAPPDATA
  const base = local && local.length > 0 ? local : join(homedir(), 'AppData', 'Local')
  return join(base, 'agent-island')
}

export function sessionsDir(root = registryRoot()): string {
  return join(root, 'sessions')
}

export function promptsDir(root = registryRoot()): string {
  return join(root, 'prompts')
}

export function decisionsDir(root = registryRoot()): string {
  return join(root, 'decisions')
}

export function focusDir(root = registryRoot()): string {
  return join(root, 'focus')
}

export function ensureRegistryDirs(root = registryRoot()): void {
  mkdirSync(sessionsDir(root), { recursive: true })
  mkdirSync(promptsDir(root), { recursive: true })
  mkdirSync(decisionsDir(root), { recursive: true })
  mkdirSync(focusDir(root), { recursive: true })
}
