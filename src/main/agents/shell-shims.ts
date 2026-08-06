/**
 * Shell shims that route `claude` / `codex` / `hermes` through the `island`
 * wrapper, so an agent started the way the user already types it becomes
 * visible to Agent Island.
 *
 * Two rules govern everything here:
 *
 *  1. **Fail open.** These shims shadow the binaries the user depends on. If
 *     the wrapper is missing, the Electron runtime has moved, or anything at
 *     all throws, the shim must fall through to the real executable. A broken
 *     shim must never be able to cost someone their agent.
 *  2. **Reversible.** Everything is written between marker comments so it can
 *     be removed exactly, and the original file is backed up once.
 */
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const BEGIN = '# >>> agent-island shims >>>'
const END = '# <<< agent-island shims <<<'

export interface ShimResult {
  ok: boolean
  installed: string[]
  errors: string[]
}

/** Absolute path to the built wrapper entry point. */
function wrapperPath(): string {
  // out/main/wrapper.js next to out/main/index.js in both dev and packaged runs.
  return join(app.getAppPath(), 'out', 'main', 'wrapper.js')
}

function electronPath(): string {
  return process.execPath
}

/** Where the standalone `island` launchers live. */
export function launcherDir(): string {
  return join(app.getPath('userData'), 'bin')
}

/**
 * Write `island.cmd` and `island` (bash) so the command exists whether or not
 * the user has opted into shell integration.
 *
 * Without these, the only way to start an observed session was the shell
 * functions — and the fallback advice ("run `island claude`") pointed at a
 * command that did not exist anywhere, which made it circular. Regenerated on
 * every launch so the paths follow the app if it moves.
 */
export function ensureLauncherScripts(): string {
  const dir = launcherDir()
  mkdirSync(dir, { recursive: true })
  const exe = electronPath()
  const wrapper = wrapperPath()

  writeFileSync(
    join(dir, 'island.cmd'),
    [
      '@echo off',
      'setlocal',
      `set "AI_WRAPPER=${wrapper}"`,
      'set "AI_NODE="',
      // Plain node is strongly preferred: Electron is a GUI-subsystem binary, so
      // under ELECTRON_RUN_AS_NODE its stdio is never recognised as a console.
      // stdin.isTTY is false, raw mode cannot be set, and VT sequences are
      // printed literally instead of being interpreted — the agent is unusable.
      "for /f \"delims=\" %%i in ('where node 2^>nul') do if not defined AI_NODE set \"AI_NODE=%%i\"",
      'if defined AI_NODE goto :usenode',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `"${exe}" "%AI_WRAPPER%" %*`,
      'goto :eof',
      ':usenode',
      '"%AI_NODE%" "%AI_WRAPPER%" %*',
      ''
    ].join('\r\n'),
    'utf8'
  )

  writeFileSync(
    join(dir, 'island'),
    [
      '#!/bin/bash',
      `wrapper="${toPosix(wrapper)}"`,
      'if command -v node >/dev/null 2>&1; then',
      '  exec node "$wrapper" "$@"',
      'fi',
      `ELECTRON_RUN_AS_NODE=1 exec "${toPosix(exe)}" "$wrapper" "$@"`,
      ''
    ].join('\n'),
    'utf8'
  )

  return dir
}

/**
 * PowerShell functions. `$env:ELECTRON_RUN_AS_NODE` makes the Electron binary
 * behave as plain node, which is required because node-pty is compiled against
 * Electron's ABI.
 */
function powerShellBlock(): string {
  const exe = electronPath().replace(/'/g, "''")
  const wrapper = wrapperPath().replace(/'/g, "''")
  const bin = launcherDir().replace(/'/g, "''")
  const lines = [
    BEGIN,
    '# Remove this block to uninstall. Agent Island rewrites it on demand.',
    `if (Test-Path '${bin}') { $env:PATH = '${bin}' + [IO.Path]::PathSeparator + $env:PATH }`
  ]
  for (const agent of ['claude', 'codex', 'hermes']) {
    lines.push(
      `function ${agent} {`,
      `  $island = '${wrapper}'`,
      `  $node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue |`,
      `    Select-Object -First 1).Source`,
      `  if ((Test-Path $island) -and $node) {`,
      `    & $node $island ${agent} @args`,
      `  } else {`,
      `    # Fail open: fall back to the real executable.`,
      `    $real = Get-Command ${agent} -CommandType Application -ErrorAction SilentlyContinue |`,
      `      Select-Object -First 1`,
      `    if ($real) { & $real.Source @args } else { Write-Error '${agent} not found' }`,
      `  }`,
      `}`
    )
  }
  lines.push(END, '')
  return lines.join('\n')
}

/** Bash functions for Git Bash / MSYS. */
function bashBlock(): string {
  const exe = toPosix(electronPath())
  const wrapper = toPosix(wrapperPath())
  const bin = toPosix(launcherDir())
  const lines = [
    BEGIN,
    '# Remove this block to uninstall.',
    `[ -d "${bin}" ] && case ":$PATH:" in *":${bin}:"*) ;; *) PATH="${bin}:$PATH" ;; esac`
  ]
  for (const agent of ['claude', 'codex', 'hermes']) {
    lines.push(
      `${agent}() {`,
      `  local island="${wrapper}"`,
      `  if [ -f "$island" ] && command -v node >/dev/null 2>&1; then`,
      `    node "$island" ${agent} "$@"`,
      `  else`,
      `    # Fail open: run the real executable.`,
      `    command ${agent} "$@"`,
      `  fi`,
      `}`
    )
  }
  lines.push(END, '')
  return lines.join('\n')
}

function toPosix(winPath: string): string {
  const m = /^([A-Za-z]):\\(.*)$/.exec(winPath)
  if (!m) return winPath.replace(/\\/g, '/')
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

function powerShellProfilePath(): string {
  const docs = join(homedir(), 'Documents')
  return join(docs, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1')
}

function bashProfilePath(): string {
  return join(homedir(), '.bashrc')
}

function stripBlock(contents: string): string {
  const start = contents.indexOf(BEGIN)
  if (start === -1) return contents
  const end = contents.indexOf(END, start)
  if (end === -1) return contents.slice(0, start)
  return contents.slice(0, start) + contents.slice(end + END.length).replace(/^\r?\n/, '')
}

function writeProfile(path: string, block: string | null): void {
  mkdirSync(dirname(path), { recursive: true })
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (existing && !existsSync(`${path}.agent-island-backup`)) {
    copyFileSync(path, `${path}.agent-island-backup`)
  }
  const cleaned = stripBlock(existing)
  if (block === null) {
    writeFileSync(path, cleaned, 'utf8')
    return
  }
  const needsNewline = cleaned.length > 0 && !cleaned.endsWith('\n')
  writeFileSync(path, cleaned + (needsNewline ? '\n' : '') + block, 'utf8')
}

export function installShellShims(): ShimResult {
  const installed: string[] = []
  const errors: string[] = []
  if (process.platform !== 'win32') {
    return { ok: false, installed, errors: ['Shell shims are Windows-only for now.'] }
  }
  if (!existsSync(wrapperPath())) {
    return { ok: false, installed, errors: [`Wrapper not found at ${wrapperPath()}`] }
  }

  try {
    writeProfile(powerShellProfilePath(), powerShellBlock())
    installed.push(powerShellProfilePath())
  } catch (error) {
    errors.push(`PowerShell profile: ${String(error)}`)
  }

  try {
    writeProfile(bashProfilePath(), bashBlock())
    installed.push(bashProfilePath())
  } catch (error) {
    errors.push(`.bashrc: ${String(error)}`)
  }

  return { ok: installed.length > 0, installed, errors }
}

export function removeShellShims(): ShimResult {
  const installed: string[] = []
  const errors: string[] = []
  for (const path of [powerShellProfilePath(), bashProfilePath()]) {
    try {
      if (existsSync(path)) {
        writeProfile(path, null)
        installed.push(path)
      }
    } catch (error) {
      errors.push(`${path}: ${String(error)}`)
    }
  }
  return { ok: errors.length === 0, installed, errors }
}

/** Appends a one-line note so `island` is discoverable without the shims. */
export function shimStatus(): {
  wrapper: string
  electron: string
  wrapperExists: boolean
  launcher: string
  launcherOnPath: boolean
} {
  const launcher = join(launcherDir(), 'island.cmd')
  const dirs = (process.env.PATH ?? '').split(';').map((entry) => entry.trim().replace(/\+$/, ''))
  return {
    wrapper: wrapperPath(),
    electron: electronPath(),
    wrapperExists: existsSync(wrapperPath()),
    launcher,
    launcherOnPath: dirs.includes(launcherDir().replace(/\+$/, ''))
  }
}
