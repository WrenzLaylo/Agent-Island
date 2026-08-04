import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { AgentId } from '@shared/contracts'
import type { PtySessionInfo } from '@shared/pty-types'
import '@xterm/xterm/css/xterm.css'

interface TerminalPanelProps {
  agentId: AgentId
  label: string
  cwd: string
  available: boolean
  discoveryNote: string
  onSessionChange?: (info: PtySessionInfo | null, error?: string) => void
}

export function TerminalPanel({
  agentId,
  label,
  cwd,
  available,
  discoveryNote,
  onSessionChange
}: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const agentRef = useRef(agentId)
  const [status, setStatus] = useState<'starting' | 'live' | 'exited' | 'error' | 'unavailable'>(
    available ? 'starting' : 'unavailable'
  )
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    agentRef.current = agentId
  }, [agentId])

  useEffect(() => {
    const api = window.agentIsland
    const host = hostRef.current
    if (!api || !host) return

    if (!available) {
      setStatus('unavailable')
      setError(`${label} executable was not found`)
      onSessionChange?.(null, `${label} unavailable`)
      return
    }

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      theme: {
        background: '#0a0a0c',
        foreground: '#f4f1ea',
        cursor: '#d4a017',
        selectionBackground: 'rgba(212, 160, 23, 0.35)'
      },
      allowProposedApi: true,
      scrollback: 5000,
      convertEol: false
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    term.focus()
    termRef.current = term
    fitRef.current = fit

    let disposed = false
    const offData = api.onPtyData((event: { agentId: AgentId; data: string }) => {
      if (event.agentId !== agentRef.current) return
      term.write(event.data)
    })
    const offExit = api.onPtyExit((event: { agentId: AgentId; exitCode: number }) => {
      if (event.agentId !== agentRef.current) return
      setStatus('exited')
      term.writeln('')
      term.writeln(`\r\n\x1b[90m[process exited: ${event.exitCode}]\x1b[0m`)
      onSessionChange?.(null, `exited ${event.exitCode}`)
    })

    const dataDisposable = term.onData((data: string) => {
      void api.ptyWrite({ agentId: agentRef.current, data })
    })

    const start = async () => {
      fit.fit()
      const cols = Math.max(term.cols, 40)
      const rows = Math.max(term.rows, 12)
      const result = await api.ptyStart({
        agentId,
        cols,
        rows,
        cwd: cwd || undefined
      })
      if (disposed) return
      if (!result.ok || !result.session) {
        setStatus('error')
        setError(result.error ?? 'Failed to start session')
        term.writeln(`\x1b[31m${result.error ?? 'Failed to start session'}\x1b[0m`)
        onSessionChange?.(null, result.error)
        return
      }
      setStatus('live')
      setError(undefined)
      if (result.replay) {
        term.write(result.replay)
      }
      onSessionChange?.(result.session)
      term.focus()
    }

    void start()

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        void api.ptyResize({
          agentId: agentRef.current,
          cols: Math.max(term.cols, 20),
          rows: Math.max(term.rows, 5)
        })
      } catch {
        // ignore fit races while unmounting
      }
    })
    ro.observe(host)

    return () => {
      disposed = true
      offData()
      offExit()
      dataDisposable.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // Intentionally only restart when agent/availability/cwd change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, available, cwd, label])

  const restart = async () => {
    const api = window.agentIsland
    if (!api || !available) return
    setStatus('starting')
    setError(undefined)
    await api.ptyStop({ agentId, force: true })
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.reset()
    fit.fit()
    const result = await api.ptyStart({
      agentId,
      cols: Math.max(term.cols, 40),
      rows: Math.max(term.rows, 12),
      cwd: cwd || undefined
    })
    if (!result.ok || !result.session) {
      setStatus('error')
      setError(result.error ?? 'Failed to restart')
      term.writeln(`\x1b[31m${result.error ?? 'Failed to restart'}\x1b[0m`)
      onSessionChange?.(null, result.error)
      return
    }
    setStatus('live')
    if (result.replay) term.write(result.replay)
    onSessionChange?.(result.session)
    term.focus()
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-meta">
        <span>
          {label}
          <span className="muted"> · {status}</span>
        </span>
        <span className="muted">{cwd || 'default cwd'}</span>
      </div>
      <div className="terminal-body xterm-host" ref={hostRef} aria-label={`${label} terminal`} />
      <div className="terminal-input-row">
        <div className="muted tiny terminal-hint">
          {error ?? discoveryNote}
        </div>
        <button type="button" className="ghost" onClick={() => void restart()} disabled={!available}>
          Restart
        </button>
      </div>
    </div>
  )
}
