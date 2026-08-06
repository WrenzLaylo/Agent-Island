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

/**
 * PowerShell functions. `$env:ELECTRON_RUN_AS_NODE` makes the Electron binary
 * behave as plain node, which is required because node-pty is compiled against
 * Electron's ABI.
 */
function powerShellBlock(): string {
  const exe = electronPath().replace(/'/g, "''")
  const wrapper = wrapperPath().replace(/'/g, "''")
  const lines = [BEGIN, "# Remove this block to uninstall. Agent Island rewrites it on demand."]
  for (const agent of ['claude', 'codex', 'hermes']) {
    lines.push(
      `function ${agent} {`,
      `  $island = '${wrapper}'`,
      `  $electron = '${exe}'`,
      `  if ((Test-Path $island) -and (Test-Path $electron)) {`,
      `    $env:ELECTRON_RUN_AS_NODE = '1'`,
      `    & $electron $island ${agent} @args`,
      `    Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`,
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
  const lines = [BEGIN, '# Remove this block to uninstall.']
  for (const agent of ['claude', 'codex', 'hermes']) {
    lines.push(
      `${agent}() {`,
      `  local island="${wrapper}"`,
      `  local electron="${exe}"`,
      `  if [ -f "$island" ] && [ -f "$electron" ]; then`,
      `    ELECTRON_RUN_AS_NODE=1 "$electron" "$island" ${agent} "$@"`,
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
export function shimStatus(): { wrapper: string; electron: string; wrapperExists: boolean } {
  return {
    wrapper: wrapperPath(),
    electron: electronPath(),
    wrapperExists: existsSync(wrapperPath())
  }
}
