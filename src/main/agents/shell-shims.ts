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
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

/** cmd files need CRLF; kept as a constant so no editor can eat it. */
const CRLF = String.fromCharCode(13, 10)

const BEGIN = '# >>> agent-island shims >>>'
const END = '# <<< agent-island shims <<<'

export interface ShimResult {
  ok: boolean
  installed: string[]
  errors: string[]
}

/**
 * Absolute path to the built wrapper entry point.
 *
 * In a packaged build `app.getAppPath()` points inside `app.asar`. Electron can
 * read that, but the shims prefer plain `node` when it is on PATH, and node
 * knows nothing about asar — it would report the wrapper as missing and the
 * shim would fail open to the bare agent, silently costing the user every
 * feature this app provides.
 *
 * `asarUnpack` in electron-builder.yml keeps a real copy on disk beside the
 * archive; this returns that copy whenever it exists, so both runtimes can
 * load it.
 */
/**
 * Absolute path to the built Claude hook, unpacked like the wrapper.
 *
 * Claude Code spawns hooks with plain node, which cannot read inside an asar.
 */
function hookPath(name: string): string {
  const packed = join(app.getAppPath(), 'out', 'main', name)
  const unpacked = packed.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  if (unpacked !== packed && existsSync(unpacked)) return unpacked
  return packed
}

/** Stable paths the agents' config files point at, regenerated on every launch. */
export function claudeHookLauncher(): string {
  return join(launcherDir(), 'claude-hook.cmd')
}

export function codexHookLauncher(): string {
  return join(launcherDir(), 'codex-hook.cmd')
}

/** SessionStart / SessionEnd, which publish the session itself. */
export function claudeSessionHookLauncher(): string {
  return join(launcherDir(), 'claude-session-hook.cmd')
}

function wrapperPath(): string {
  // out/main/wrapper.js next to out/main/index.js in both dev and packaged runs.
  const packed = join(app.getAppPath(), 'out', 'main', 'wrapper.js')
  const unpacked = packed.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  if (unpacked !== packed && existsSync(unpacked)) return unpacked
  return packed
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

  /*
   * The hook launcher is what `~/.claude/settings.json` records, rather than
   * the build output directly: this path is stable, so an update that moves
   * out/ does not leave the user's settings pointing at a file that is gone.
   * Regenerated here on every launch for exactly that reason.
   */
  for (const hook of ['claude', 'codex', 'claude-session']) writeHookLauncher(dir, exe, hook)

  return dir
}

/** One cmd shim per hook; identical but for which script they run. */
function writeHookLauncher(dir: string, exe: string, agent: string): void {
  writeFileSync(
    join(dir, `${agent}-hook.cmd`),
    [
      '@echo off',
      `set "AI_HOOK=${hookPath(`${agent}-hook.js`)}"`,
      'set "AI_NODE="',
      "for /f \"delims=\" %%i in ('where node 2^>nul') do if not defined AI_NODE set \"AI_NODE=%%i\"",
      'if defined AI_NODE goto :usenode',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `"${exe}" "%AI_HOOK%"`,
      'goto :eof',
      ':usenode',
      '"%AI_NODE%" "%AI_HOOK%"',
      ''
    ].join(CRLF),
    'utf8'
  )
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
      `    # Prefer something Windows can actually start. Get-Command lists npm's`,
      `    # extensionless shim alongside its .cmd, and CreateProcess fails on the`,
      `    # extensionless one with error 193 - taking -First 1 picked exactly that.`,
      `    $real = Get-Command ${agent} -CommandType Application -ErrorAction SilentlyContinue |`,
      `      Sort-Object @{ Expression = {`,
      `        $e = [IO.Path]::GetExtension($_.Source).ToLower()`,
      `        switch ($e) { '.exe' {0} '.cmd' {1} '.bat' {2} '.com' {3} '' {5} default {4} } } } |`,
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

/** PowerShell 7+ reads a different profile than Windows PowerShell 5.1. */
function pwshProfilePath(): string {
  return join(homedir(), 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
}

/*
 * cmd.exe has no profile. The only startup hook is the Command Processor
 * `AutoRun` registry value, which cmd executes when it starts — including for
 * non-interactive `cmd /c` invocations made by other programs. Two rules follow:
 *
 *  - The script must print nothing, ever. Anything it writes lands in the
 *    output of every `cmd /c` on the machine and breaks tools that parse it.
 *  - It must be chained, not overwritten. Clink and others use AutoRun too, so
 *    an existing value is preserved and only our own segment is removed on
 *    uninstall.
 *
 * cmd has no functions, so the commands are doskey macros. Those only apply to
 * interactive sessions, which is the behaviour we want anyway: a batch script
 * calling `claude` keeps calling the real binary.
 */
const AUTORUN_SCRIPT = 'cmd-autorun.cmd'

function cmdAutoRunPath(): string {
  return join(launcherDir(), AUTORUN_SCRIPT)
}

function writeCmdAutoRunScript(): void {
  const launcher = join(launcherDir(), 'island.cmd')
  writeFileSync(
    cmdAutoRunPath(),
    [
      '@echo off',
      'rem Agent Island cmd.exe integration. Silent by design.',
      `if not exist "${launcher}" goto :eof`,
      `set "PATH=${launcherDir()};%PATH%"`,
      `doskey claude="${launcher}" claude $*`,
      `doskey codex="${launcher}" codex $*`,
      `doskey hermes="${launcher}" hermes $*`,
      ''
    ].join('\r\n'),
    'utf8'
  )
}

function readAutoRun(): string {
  try {
    const out = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Command Processor', '/v', 'AutoRun'],
      { encoding: 'utf8', windowsHide: true }
    )
    const match = /AutoRun\s+REG_[A-Z_]+\s+(.*)/.exec(out)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

function writeAutoRun(value: string): void {
  if (value) {
    execFileSync(
      'reg.exe',
      ['add', 'HKCU\\Software\\Microsoft\\Command Processor', '/v', 'AutoRun', '/t', 'REG_SZ', '/d', value, '/f'],
      { windowsHide: true }
    )
  } else {
    execFileSync(
      'reg.exe',
      ['delete', 'HKCU\\Software\\Microsoft\\Command Processor', '/v', 'AutoRun', '/f'],
      { windowsHide: true }
    )
  }
}

function autoRunSegment(): string {
  return `if exist "${cmdAutoRunPath()}" call "${cmdAutoRunPath()}"`
}

function installCmdAutoRun(): void {
  writeCmdAutoRunScript()
  const existing = readAutoRun()
  if (existing.includes(AUTORUN_SCRIPT)) return
  writeAutoRun(existing ? `${existing} & ${autoRunSegment()}` : autoRunSegment())
}

function removeCmdAutoRun(): void {
  const existing = readAutoRun()
  if (!existing.includes(AUTORUN_SCRIPT)) return
  const kept = existing
    .split('&')
    .map((part) => part.trim())
    .filter((part) => part && !part.includes(AUTORUN_SCRIPT))
    .join(' & ')
  writeAutoRun(kept)
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
    writeProfile(pwshProfilePath(), powerShellBlock())
    installed.push(pwshProfilePath())
  } catch (error) {
    errors.push(`PowerShell 7 profile: ${String(error)}`)
  }

  try {
    writeProfile(bashProfilePath(), bashBlock())
    installed.push(bashProfilePath())
  } catch (error) {
    errors.push(`.bashrc: ${String(error)}`)
  }

  try {
    installCmdAutoRun()
    installed.push('cmd.exe (AutoRun)')
  } catch (error) {
    errors.push(`cmd.exe: ${String(error)}`)
  }

  return { ok: installed.length > 0, installed, errors }
}

export function removeShellShims(): ShimResult {
  const installed: string[] = []
  const errors: string[] = []
  for (const path of [powerShellProfilePath(), pwshProfilePath(), bashProfilePath()]) {
    try {
      if (existsSync(path)) {
        writeProfile(path, null)
        installed.push(path)
      }
    } catch (error) {
      errors.push(`${path}: ${String(error)}`)
    }
  }
  try {
    removeCmdAutoRun()
    installed.push('cmd.exe (AutoRun)')
  } catch (error) {
    errors.push(`cmd.exe: ${String(error)}`)
  }
  return { ok: errors.length === 0, installed, errors }
}

/**
 * Whether the shims are on disk right now.
 *
 * Derived, never remembered. A stored boolean drifts out of step with reality
 * the moment anything writes the profiles from outside the running app — the
 * headless `--install-shims` did exactly that, and the Settings panel then
 * offered to install shims that were already there.
 */
export function shimsInstalled(): boolean {
  const marked = (path: string): boolean => {
    try {
      return existsSync(path) && readFileSync(path, 'utf8').includes(BEGIN)
    } catch {
      return false
    }
  }
  if (marked(powerShellProfilePath()) || marked(pwshProfilePath()) || marked(bashProfilePath())) {
    return true
  }
  return readAutoRun().includes(AUTORUN_SCRIPT)
}

export function shimStatus(): {
  wrapper: string
  electron: string
  wrapperExists: boolean
  launcher: string
  launcherOnPath: boolean
  installed: boolean
} {
  const launcher = join(launcherDir(), 'island.cmd')
  const dirs = (process.env.PATH ?? '').split(';').map((entry) => entry.trim().replace(/\+$/, ''))
  return {
    wrapper: wrapperPath(),
    electron: electronPath(),
    wrapperExists: existsSync(wrapperPath()),
    launcher,
    launcherOnPath: dirs.includes(launcherDir().replace(/\+$/, '')),
    installed: shimsInstalled()
  }
}
