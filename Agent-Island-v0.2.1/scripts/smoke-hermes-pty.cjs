/**
 * Headless Phase 2 smoke: discover agents + start Hermes via PtyManager.
 * Run: npx electron scripts/smoke-hermes-pty.cjs
 */
const { app } = require('electron')
const path = require('path')
const { pathToFileURL } = require('url')

async function loadManager() {
  // Compiled JS may not exist; import TS sources via electron-vite out if present.
  const outMain = path.join(__dirname, '..', 'out', 'main', 'index.js')
  // Directly require node-pty path and inline minimal discover + manager by dynamic import of source is hard in CJS.
  // Use the same logic as process-manager via node-pty directly against discovered hermes path.
  const pty = require('node-pty')
  const { access } = require('fs/promises')
  const { constants } = require('fs')
  const { execFile } = require('child_process')
  const { promisify } = require('util')
  const { homedir } = require('os')
  const { join } = require('path')
  const execFileAsync = promisify(execFile)

  async function pathExists(p) {
    try {
      await access(p, constants.F_OK)
      return true
    } catch {
      return false
    }
  }
  async function which(cmd) {
    try {
      const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
        windowsHide: true,
        timeout: 5000
      })
      return stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    } catch {
      return undefined
    }
  }

  const home = homedir()
  const candidates = [
    await which('hermes'),
    join(home, 'AppData', 'Local', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
    join(home, 'AppData', 'Local', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes')
  ].filter(Boolean)

  let hermes
  for (const c of candidates) {
    if (await pathExists(c)) {
      hermes = c
      break
    }
  }
  if (!hermes) throw new Error('Hermes executable not found')

  return { pty, hermes }
}

app.whenReady().then(async () => {
  try {
    const { pty, hermes } = await loadManager()
    console.log('HERMES_PATH', hermes)
    const term = pty.spawn(hermes, ['--version'], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env: process.env
    })
    let out = ''
    term.onData((d) => {
      out += d
    })
    await new Promise((resolve) => {
      term.onExit(() => resolve())
      setTimeout(resolve, 5000)
    })
    try {
      term.kill()
    } catch {
      // ignore
    }
    console.log('HERMES_OUT_START')
    console.log(out.slice(0, 800))
    console.log('HERMES_OUT_END')
    const ok = /hermes|agent|v?\d+\.\d+/i.test(out)
    console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAIL')
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('SMOKE_ERROR', err)
    app.exit(2)
  }
})
