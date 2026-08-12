/**
 * Install / remove Agent Island's `PermissionRequest` hook in
 * `$CODEX_HOME/hooks.json`.
 *
 * Format taken from the vendored source — `core/src/mcp_tool_call_tests.rs`
 * writes exactly this shape:
 *
 * ```json
 * { "hooks": { "PermissionRequest": [ { "matcher": "…",
 *     "hooks": [ { "type": "command", "command": "…", "timeout_sec": 5 } ] } ] } }
 * ```
 *
 * Same two rules as the Claude installer: reversible via a marker, and never
 * destructive — a file that fails to parse is refused rather than replaced.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const CODEX_HOOK_MARKER = 'agent-island'

export interface CodexHookEntry {
  type: string
  command: string
  timeout_sec?: number
  _source?: string
}

export interface CodexHookMatcher {
  matcher?: string
  hooks?: CodexHookEntry[]
}

export interface CodexHooksFile {
  hooks?: Record<string, CodexHookMatcher[]>
  [key: string]: unknown
}

export function codexHooksPath(): string {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex')
  return join(home, 'hooks.json')
}

export function isOurs(entry: CodexHookEntry): boolean {
  return entry?._source === CODEX_HOOK_MARKER
}

/**
 * The timeout Codex allows the handler.
 *
 * Must exceed the hook's own wait, or Codex kills it mid-question and the user
 * sees a card that can no longer be answered.
 */
export const CODEX_HOOK_TIMEOUT_SEC = 130

export function withCodexHookInstalled(file: CodexHooksFile, command: string): CodexHooksFile {
  const next: CodexHooksFile = { ...file }
  const hooks: Record<string, CodexHookMatcher[]> = { ...(next.hooks ?? {}) }
  const existing = Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest : []

  const cleaned = existing
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((entry) => !isOurs(entry)) }))
    .filter((group) => (group.hooks ?? []).length > 0)

  cleaned.push({
    // Empty matcher = every tool, so a tool added in a later Codex release is
    // covered without this needing to change.
    matcher: '',
    hooks: [
      { type: 'command', command, timeout_sec: CODEX_HOOK_TIMEOUT_SEC, _source: CODEX_HOOK_MARKER }
    ]
  })

  hooks.PermissionRequest = cleaned
  next.hooks = hooks
  return next
}

export function withCodexHookRemoved(file: CodexHooksFile): CodexHooksFile {
  const next: CodexHooksFile = { ...file }
  if (!next.hooks || !Array.isArray(next.hooks.PermissionRequest)) return next

  const hooks: Record<string, CodexHookMatcher[]> = { ...next.hooks }
  const cleaned = hooks.PermissionRequest.map((group) => ({
    ...group,
    hooks: (group.hooks ?? []).filter((entry) => !isOurs(entry))
  })).filter((group) => (group.hooks ?? []).length > 0)

  if (cleaned.length > 0) hooks.PermissionRequest = cleaned
  else delete hooks.PermissionRequest

  if (Object.keys(hooks).length > 0) next.hooks = hooks
  else delete next.hooks
  return next
}

export function codexHookIsInstalled(file: CodexHooksFile): boolean {
  const groups = file?.hooks?.PermissionRequest
  if (!Array.isArray(groups)) return false
  return groups.some((group) => (group.hooks ?? []).some(isOurs))
}

function readHooks(path: string): { ok: true; value: CodexHooksFile } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true, value: {} }
  try {
    const raw = readFileSync(path, 'utf8').replace(/^﻿/, '')
    if (raw.trim().length === 0) return { ok: true, value: {} }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'hooks.json is not a JSON object' }
    }
    return { ok: true, value: parsed as CodexHooksFile }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function writeHooks(path: string, file: CodexHooksFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const backup = `${path}.agent-island-backup`
  if (existsSync(path) && !existsSync(backup)) copyFileSync(path, backup)
  const tmp = `${path}.agent-island-tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

export interface CodexHookStatus {
  installed: boolean
  hooksPath: string
  error?: string
}

export function codexHookStatus(path = codexHooksPath()): CodexHookStatus {
  const read = readHooks(path)
  if (!read.ok) return { installed: false, hooksPath: path, error: read.error }
  return { installed: codexHookIsInstalled(read.value), hooksPath: path }
}

export function installCodexHook(
  command: string,
  path = codexHooksPath()
): { ok: boolean; error?: string } {
  const read = readHooks(path)
  if (!read.ok) return { ok: false, error: `Could not read ${path}: ${read.error}` }
  try {
    writeHooks(path, withCodexHookInstalled(read.value, command))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function uninstallCodexHook(path = codexHooksPath()): { ok: boolean; error?: string } {
  const read = readHooks(path)
  if (!read.ok) return { ok: false, error: `Could not read ${path}: ${read.error}` }
  try {
    writeHooks(path, withCodexHookRemoved(read.value))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
