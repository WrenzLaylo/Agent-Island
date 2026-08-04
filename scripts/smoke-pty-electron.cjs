const { app } = require('electron')
const path = require('path')

app.whenReady().then(() => {
  try {
    const pty = require('node-pty')
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash'
    const term = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: process.cwd()
    })
    let out = ''
    term.onData((d) => {
      out += d
    })
    setTimeout(() => {
      term.write('echo PTY_OK_FROM_ELECTRON\r')
    }, 300)
    setTimeout(() => {
      term.kill()
      console.log('ELECTRON_PTY_RESULT_START')
      console.log(out.includes('PTY_OK_FROM_ELECTRON') ? 'SUCCESS' : 'FAIL')
      console.log(out.slice(-400))
      console.log('ELECTRON_PTY_RESULT_END')
      console.log('versions', process.versions.electron, process.versions.modules)
      app.exit(out.includes('PTY_OK_FROM_ELECTRON') ? 0 : 1)
    }, 1800)
  } catch (err) {
    console.error('ELECTRON_PTY_ERROR', err)
    app.exit(2)
  }
})
