import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { AgentId, AgentSnapshot } from '@shared/contracts'
import { AGENT_ORDER } from '@shared/contracts'
import type { PtySessionInfo } from '@shared/pty-types'
import '@xterm/xterm/css/xterm.css'

interface MultiAgentTerminalsProps {
  agents: Record<AgentId, AgentSnapshot>
  activeAgentId: AgentId
  discoveryNote: string
  /** When false, terminals stay mounted but hidden (keeps scrollback). */
  visible: boolean
  onSessionChange?: (agentId: AgentId, info: PtySessionInfo | null, error?: string) => void
}

/**
 * One xterm + one PTY binding per agent.
 * Switching tabs only toggles visibility — it does not dispose other sessions.
 */
export function MultiAgentTerminals({
  agents,
  activeAgentId,
  discoveryNote,
  visible,
  onSessionChange
}: MultiAgentTerminalsProps) {
  const active = agents[activeAgentId]

  const restartActive = useCallback(async () => {
    const api = window.agentIsland
    if (!api || !active.available) return
    await api.ptyStop({ agentId: activeAgentId, force: true })
    // Child AgentTerminal listens for stop via exit + user can click Restart on that pane.
    // Explicit restart is handled inside AgentTerminal; this is a thin toolbar control.
    window.dispatchEvent(new CustomEvent('agent-island:restart', { detail: { agentId: activeAgentId } }))
  }, [active.available, activeAgentId])

  return (
    <div className={`terminal-panel multi ${visible ? 'is-visible' : 'is-hidden'}`}>
      <div className="terminal-meta">
        <span>
          {active.label}
          <span className="muted">
            {' '}
            · {active.status}
            {active.available ? '' : ' · missing'}
          </span>
        </span>
        <span className="muted">{active.cwd || 'default cwd'}</span>
      </div>

      <div className="terminal-stack">
        {AGENT_ORDER.map((id) => (
          <AgentTerminal
            key={id}
            agent={agents[id]}
            active={id === activeAgentId}
            onSessionChange={onSessionChange}
          />
        ))}
      </div>

      <div className="terminal-input-row">
        <div className="muted tiny terminal-hint">{discoveryNote}</div>
        <button
          type="button"
          className="ghost"
          onClick={() => void restartActive()}
          disabled={!active.available}
        >
          Restart
        </button>
      </div>
    </div>
  )
}

function AgentTerminal({
  agent,
  active,
  onSessionChange
}: {
  agent: AgentSnapshot
  active: boolean
  onSessionChange?: (agentId: AgentId, info: PtySessionInfo | null, error?: string) => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const startedRef = useRef(false)
  const [error, setError] = useState<string | undefined>()

  // Create xterm once per agent mount.
  useEffect(() => {
    const host = hostRef.current
    const api = window.agentIsland
    if (!host || !api) return

    if (!agent.available) {
      setError(`${agent.label} executable was not found`)
      onSessionChange?.(agent.id, null, `${agent.label} unavailable`)
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
    termRef.current = term
    fitRef.current = fit

    let disposed = false

    const offData = api.onPtyData((event: { agentId: AgentId; data: string }) => {
      if (event.agentId !== agent.id) return
      term.write(event.data)
    })
    const offExit = api.onPtyExit((event: { agentId: AgentId; exitCode: number }) => {
      if (event.agentId !== agent.id) return
      startedRef.current = false
      term.writeln('')
      term.writeln(`\r\n\x1b[90m[process exited: ${event.exitCode}]\x1b[0m`)
      onSessionChange?.(agent.id, null, `exited ${event.exitCode}`)
    })
    const dataDisposable = term.onData((data: string) => {
      void api.ptyWrite({ agentId: agent.id, data })
    })

    const startSession = async (forceNew = false) => {
      if (disposed) return
      fit.fit()
      if (forceNew) {
        await api.ptyStop({ agentId: agent.id, force: true })
        term.reset()
        startedRef.current = false
      }
      const result = await api.ptyStart({
        agentId: agent.id,
        cols: Math.max(term.cols, 40),
        rows: Math.max(term.rows, 12),
        cwd: agent.cwd || undefined
      })
      if (disposed) return
      if (!result.ok || !result.session) {
        setError(result.error ?? 'Failed to start session')
        term.writeln(`\x1b[31m${result.error ?? 'Failed to start session'}\x1b[0m`)
        onSessionChange?.(agent.id, null, result.error)
        return
      }
      startedRef.current = true
      setError(undefined)
      // Only paint replay when attaching to an already-running session.
      if (result.replay) {
        term.reset()
        term.write(result.replay)
      }
      onSessionChange?.(agent.id, result.session)
      if (active) term.focus()
    }

    // Lazy-start only when this tab becomes active the first time,
    // or when restart is requested. Keeps idle agents from spawning until needed.
    const maybeStart = () => {
      if (active && !startedRef.current) {
        void startSession(false)
      }
    }
    maybeStart()

    const onRestart = (ev: Event) => {
      const detail = (ev as CustomEvent<{ agentId: AgentId }>).detail
      if (detail?.agentId !== agent.id) return
      void startSession(true)
    }
    window.addEventListener('agent-island:restart', onRestart)

    const ro = new ResizeObserver(() => {
      if (!active) return
      try {
        fit.fit()
        if (startedRef.current) {
          void api.ptyResize({
            agentId: agent.id,
            cols: Math.max(term.cols, 20),
            rows: Math.max(term.rows, 5)
          })
        }
      } catch {
        // ignore
      }
    })
    ro.observe(host)

    return () => {
      disposed = true
      window.removeEventListener('agent-island:restart', onRestart)
      offData()
      offExit()
      dataDisposable.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      // Intentionally do NOT stop the PTY here — multi-session must survive UI unmount.
    }
    // Mount once per agent id/availability. Active changes handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, agent.available, agent.cwd, agent.label])

  // When tab becomes active: ensure session started + fit + focus.
  useEffect(() => {
    if (!active) return
    const api = window.agentIsland
    const term = termRef.current
    const fit = fitRef.current
    if (!api || !term || !fit || !agent.available) return

    const run = async () => {
      fit.fit()
      if (!startedRef.current) {
        const result = await api.ptyStart({
          agentId: agent.id,
          cols: Math.max(term.cols, 40),
          rows: Math.max(term.rows, 12),
          cwd: agent.cwd || undefined
        })
        if (result.ok && result.session) {
          startedRef.current = true
          if (result.replay) {
            term.reset()
            term.write(result.replay)
          }
          onSessionChange?.(agent.id, result.session)
        } else if (!result.ok) {
          setError(result.error)
          onSessionChange?.(agent.id, null, result.error)
        }
      } else {
        void api.ptyResize({
          agentId: agent.id,
          cols: Math.max(term.cols, 20),
          rows: Math.max(term.rows, 5)
        })
      }
      term.focus()
    }
    void run()
  }, [active, agent.available, agent.cwd, agent.id, onSessionChange])

  return (
    <div
      className={`agent-terminal ${active ? 'active' : 'inactive'}`}
      hidden={!active}
      aria-hidden={!active}
    >
      <div className="terminal-body xterm-host" ref={hostRef} aria-label={`${agent.label} terminal`} />
      {error && active && <div className="muted tiny term-error">{error}</div>}
    </div>
  )
}
