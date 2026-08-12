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
/** A single backslash, named so no editor or shell can eat the escape. */
const BACKSLASH = String.fromCharCode(92)

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
 * Naming tools here was tried and failed: `Bash|Write|Edit|…` never matched a
 * real shell command, because on Windows the VS Code extension runs them
 * through a tool it displays as **PowerShell**. Every command ran unannounced.
 *
 * So the matcher takes everything and the *hook* decides, skipping a small set
 * of known read-only tools with no card and no round trip. Being wrong there
 * costs one unnecessary card; being wrong in a matcher costs silence.
 */
export const CLAUDE_HOOK_MATCHER = ''

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

/**
 * Path, written the only way Claude Code can actually run it.
 *
 * Hook commands are executed through a shell, which eats backslashes as escape
 * characters: `C:\Users\…\claude-hook.cmd` arrived as
 * `C:UsersOASIS…claude-hook.cmd`, a path that does not exist. The hook was
 * therefore configured, launched, and failed silently on every single tool
 * call — indistinguishable from Claude ignoring hooks altogether, which is
 * exactly what it was mistaken for.
 *
 * Windows accepts forward slashes everywhere that matters, and they survive a
 * shell untouched.
 */
export function toHookCommand(path: string): string {
  return path.split(BACKSLASH).join('/')
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
/** Strip our entries from one event, leaving the user's own untouched. */
function withoutOurs(groups: HookMatcher[] | undefined): HookMatcher[] {
  if (!Array.isArray(groups)) return []
  return groups
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((entry) => !isOurs(entry)) }))
    .filter((group) => (group.hooks ?? []).length > 0)
}

export function withHookInstalled(
  settings: ClaudeSettings,
  command: string,
  sessionCommand?: string
): ClaudeSettings {
  const next: ClaudeSettings = { ...settings }
  const hooks: Record<string, HookMatcher[]> = { ...(next.hooks ?? {}) }

  // Ours are dropped first and re-added, so installing twice is idempotent and
  // a command path can change between versions without stacking duplicates.
  hooks.PreToolUse = [
    ...withoutOurs(hooks.PreToolUse),
    {
      matcher: CLAUDE_HOOK_MATCHER,
      hooks: [{ type: 'command', command: toHookCommand(command), timeout: 130, _source: HOOK_MARKER }]
    }
  ]

  /*
   * SessionStart and SessionEnd publish the session itself, so the island can
   * show a Claude session it did not launch. Without them it answers approvals
   * from the VS Code extension while still saying "Run island claude in a
   * terminal" — contradicting itself on the same screen.
   *
   * Short timeout: these only write or delete one small file, and nothing about
   * a session's start should ever wait on Agent Island.
   */
  if (sessionCommand) {
    for (const event of ['SessionStart', 'SessionEnd']) {
      hooks[event] = [
        ...withoutOurs(hooks[event]),
        {
          matcher: '',
          hooks: [
            { type: 'command', command: toHookCommand(sessionCommand), timeout: 10, _source: HOOK_MARKER }
          ]
        }
      ]
    }
  }

  next.hooks = hooks
  return next
}

/** Remove only our entry, leaving the user's own hooks exactly as they were. */
export function withHookRemoved(settings: ClaudeSettings): ClaudeSettings {
  const next: ClaudeSettings = { ...settings }
  if (!next.hooks) return next

  const hooks: Record<string, HookMatcher[]> = { ...next.hooks }
  // Every event we might have written to, not just PreToolUse — leaving a
  // SessionStart entry behind would keep publishing sessions after removal.
  for (const event of ['PreToolUse', 'SessionStart', 'SessionEnd']) {
    if (!Array.isArray(hooks[event])) continue
    const cleaned = withoutOurs(hooks[event])
    if (cleaned.length > 0) hooks[event] = cleaned
    else delete hooks[event]
  }

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
  sessionCommand?: string,
  path = claudeSettingsPath()
): { ok: boolean; error?: string } {
  const read = readSettings(path)
  if (!read.ok) {
    // Refuse rather than replace. Overwriting a file we cannot read would
    // destroy settings the user may not have backed up.
    return { ok: false, error: `Could not read ${path}: ${read.error}` }
  }
  try {
    writeSettings(path, withHookInstalled(read.value, command, sessionCommand))
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
