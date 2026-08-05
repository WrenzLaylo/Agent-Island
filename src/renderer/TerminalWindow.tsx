import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { AgentId } from '@shared/contracts'
import type { PtyDataEvent, PtyExitEvent, PtySessionInfo } from '@shared/pty-types'
import '@xterm/xterm/css/xterm.css'

const LABELS: Record<AgentId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  hermes: 'Hermes'
}

function queryAgent(): AgentId {
  const value = new URLSearchParams(window.location.search).get('agent')
  return value === 'claude' || value === 'codex' || value === 'hermes' ? value : 'hermes'
}

export function TerminalWindow() {
  const agentId = useMemo(queryAgent, [])
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [status, setStatus] = useState('Connecting…')
  const [cwd, setCwd] = useState('')

  useEffect(() => {
    const host = hostRef.current
    const api = window.agentIsland
    if (!host || !api) {
      setStatus('Agent Island bridge unavailable')
      return
    }

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.22,
      letterSpacing: 0,
      scrollback: 10_000,
      convertEol: false,
      allowProposedApi: true,
      theme: {
        background: '#000000',
        foreground: '#f5f5f7',
        cursor: '#f5f5f7',
        cursorAccent: '#000000',
        selectionBackground: 'rgba(255,255,255,0.20)',
        black: '#000000',
        brightBlack: '#6e6e73',
        white: '#d2d2d7',
        brightWhite: '#ffffff'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    let disposed = false

    const start = async () => {
      const result = await api.ptyStart({
        agentId,
        cols: Math.max(term.cols, 40),
        rows: Math.max(term.rows, 12)
      })
      if (disposed) return
      if (!result.ok || !result.session) {
        const message = result.error ?? `Could not start ${LABELS[agentId]}`
        setStatus(message)
        term.writeln(`\x1b[31m${message}\x1b[0m`)
        return
      }
      setStatus(result.session.alive ? 'Connected' : 'Stopped')
      setCwd(result.session.cwd)
      if (result.replay) term.write(result.replay)
      term.focus()
    }

    const offData = api.onPtyData((event: PtyDataEvent) => {
      if (event.agentId !== agentId) return
      term.write(event.data)
    })
    const offSession = api.onPtySession((session: PtySessionInfo) => {
      if (session.agentId !== agentId) return
      setStatus(session.alive ? 'Connected' : 'Stopped')
      setCwd(session.cwd)
    })
    const offExit = api.onPtyExit((event: PtyExitEvent) => {
      if (event.agentId !== agentId) return
      setStatus(`Exited with code ${event.exitCode}`)
      term.writeln(`\r\n\x1b[90m[process exited: ${event.exitCode}]\x1b[0m`)
    })
    const offFocus = api.onTerminalFocus(() => {
      fit.fit()
      term.focus()
    })
    const dataDisposable = term.onData((data) => {
      void api.ptyWrite({ agentId, data })
    })

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit()
        void api.ptyResize({
          agentId,
          cols: Math.max(term.cols, 20),
          rows: Math.max(term.rows, 5)
        })
      } catch {
        // Ignore layout races while the window is opening or closing.
      }
    })
    resizeObserver.observe(host)

    void start()

    return () => {
      disposed = true
      offData()
      offSession()
      offExit()
      offFocus()
      dataDisposable.dispose()
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      // Closing the window intentionally leaves the managed agent session alive.
    }
  }, [agentId])

  return (
    <main className="terminal-window-shell">
      <header className="terminal-window-header">
        <div>
          <strong>{LABELS[agentId]} Terminal</strong>
          <span>{status}</span>
        </div>
        <code title={cwd}>{cwd || 'Starting session…'}</code>
      </header>
      <div ref={hostRef} className="terminal-window-host" aria-label={`${LABELS[agentId]} terminal`} />
    </main>
  )
}
