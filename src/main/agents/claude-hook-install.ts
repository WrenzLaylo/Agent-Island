/**
 * Install / remove Agent Island's `PreToolUse` hook in `~/.claude/settings.json`.
 *
 * This edits a file the user's agent depends on, so it follows the same two
 * rules as the shell shims:
 *
 *  1. **Reversible.** The entry carries a marker, so removal takes out exactly
 *     what was added and nothing else. Foreign hooks are never touched.
 *  2. **Never destructive.** The file is parsed before it is written, a backup
 *     is taken once, and the write is atomic. A settings file that fails to
 *     parse is left completely alone — a malformed file is a problem to report,
 *     not to overwrite.
 *
 * Installation is a deliberate user action. Nothing here runs on launch.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Identifies our entry among the user's own hooks. */
export const HOOK_MARKER = 'agent-island'

/**
 * Which tools raise a card.
 *
 * Deliberately not every tool. Claude's `PreToolUse` fires before *all* tool
 * calls, not only ones that need permission, so an empty matcher put an island
 * card in front of every Read, Grep and Glob — unusable within seconds of real
 * work. Codex's `PermissionRequest` has no such problem, which is why its
 * matcher is empty and this one is not.
 *
 * Limited to tools that change something or reach the network. The cost of the
 * narrowing is that a future tool worth guarding is not covered until this
 * list learns about it; the cost of not narrowing is that nobody can use the
 * hook at all.
 */
export const CLAUDE_HOOK_MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch'

export interface HookEntry {
  type: string
  command: string
  timeout?: number
  /** Our marker. Absent on anything the user wrote themselves. */
  _source?: string
}

export interface HookMatcher {
  matcher?: string
  hooks?: HookEntry[]
}

export interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>
  [key: string]: unknown
}

export function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

export function isOurs(entry: HookEntry): boolean {
  return entry?._source === HOOK_MARKER
}

/**
 * Add the hook, replacing any previous copy of ours.
 *
 * Pure so the merge can be tested against real settings shapes without
 * touching a disk.
 */
export function withHookInstalled(settings: ClaudeSettings, command: string): ClaudeSettings {
  const next: ClaudeSettings = { ...settings }
  const hooks: Record<string, HookMatcher[]> = { ...(next.hooks ?? {}) }
  const existing = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []

  // Drop any earlier entry of ours, wherever it sits, then re-add. That makes
  // installing twice idempotent and lets the command path change between
  // versions without stacking duplicates.
  const cleaned = existing
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((entry) => !isOurs(entry)) }))
    .filter((group) => (group.hooks ?? []).length > 0)

  cleaned.push({
    matcher: CLAUDE_HOOK_MATCHER,
    hooks: [{ type: 'command', command, timeout: 130, _source: HOOK_MARKER }]
  })

  hooks.PreToolUse = cleaned
  next.hooks = hooks
  return next
}

/** Remove only our entry, leaving the user's own hooks exactly as they were. */
export function withHookRemoved(settings: ClaudeSettings): ClaudeSettings {
  const next: ClaudeSettings = { ...settings }
  if (!next.hooks || !Array.isArray(next.hooks.PreToolUse)) return next

  const hooks: Record<string, HookMatcher[]> = { ...next.hooks }
  const cleaned = hooks.PreToolUse.map((group) => ({
    ...group,
    hooks: (group.hooks ?? []).filter((entry) => !isOurs(entry))
  })).filter((group) => (group.hooks ?? []).length > 0)

  if (cleaned.length > 0) hooks.PreToolUse = cleaned
  else delete hooks.PreToolUse

  // Do not leave an empty `hooks: {}` behind if we emptied it.
  if (Object.keys(hooks).length > 0) next.hooks = hooks
  else delete next.hooks
  return next
}

export function hookIsInstalled(settings: ClaudeSettings): boolean {
  const groups = settings?.hooks?.PreToolUse
  if (!Array.isArray(groups)) return false
  return groups.some((group) => (group.hooks ?? []).some(isOurs))
}

export interface HookStatus {
  installed: boolean
  settingsPath: string
  /** Set when the file exists but could not be parsed. */
  error?: string
}

function readSettings(path: string): { ok: true; value: ClaudeSettings } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true, value: {} }
  try {
    const raw = readFileSync(path, 'utf8').replace(/^﻿/, '')
    if (raw.trim().length === 0) return { ok: true, value: {} }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'settings.json is not a JSON object' }
    }
    return { ok: true, value: parsed as ClaudeSettings }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function claudeHookStatus(path = claudeSettingsPath()): HookStatus {
  const read = readSettings(path)
  if (!read.ok) return { installed: false, settingsPath: path, error: read.error }
  return { installed: hookIsInstalled(read.value), settingsPath: path }
}

function writeSettings(path: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(path), { recursive: true })
  // Backed up once, never overwritten: the point is to preserve the file as it
  // was before this app ever touched it.
  const backup = `${path}.agent-island-backup`
  if (existsSync(path) && !existsSync(backup)) copyFileSync(path, backup)

  const tmp = `${path}.agent-island-tmp`
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

export function installClaudeHook(
  command: string,
  path = claudeSettingsPath()
): { ok: boolean; error?: string } {
  const read = readSettings(path)
  if (!read.ok) {
    // Refuse rather than replace. Overwriting a file we cannot read would
    // destroy settings the user may not have backed up.
    return { ok: false, error: `Could not read ${path}: ${read.error}` }
  }
  try {
    writeSettings(path, withHookInstalled(read.value, command))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function uninstallClaudeHook(path = claudeSettingsPath()): { ok: boolean; error?: string } {
  const read = readSettings(path)
  if (!read.ok) return { ok: false, error: `Could not read ${path}: ${read.error}` }
  try {
    writeSettings(path, withHookRemoved(read.value))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
