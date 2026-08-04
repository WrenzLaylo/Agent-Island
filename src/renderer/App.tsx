import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import {
  AGENT_ORDER,
  type AgentId,
  type ApprovalRequest,
  type IslandSnapshot
} from '@shared/contracts'
import {
  createInitialIslandState,
  currentApproval,
  pendingApprovalCount,
  reduceIsland,
  type IslandEvent
} from '@shared/island-machine'
import { canApproveRequest } from '@shared/approval-guard'
import { IslandShell } from './components/IslandShell'
import { DemoControls } from './components/DemoControls'

function sizeForMode(mode: IslandSnapshot['mode'], showDemo: boolean): { width: number; height: number } {
  switch (mode) {
    case 'collapsed':
      return { width: 300, height: 56 }
    case 'peek':
    case 'success':
      return { width: 460, height: showDemo ? 186 : 124 }
    case 'error':
      return { width: 480, height: showDemo ? 210 : 150 }
    case 'approval':
      return { width: 540, height: showDemo ? 360 : 300 }
    case 'expanded':
      return { width: 720, height: showDemo ? 560 : 500 }
    default:
      return { width: 300, height: 56 }
  }
}

function shortActivity(version?: string): string {
  if (!version) return 'Ready'
  const match = version.match(/v?\d+\.\d+(?:\.\d+)?/)
  return match ? `v${match[0].replace(/^v/, '')}` : 'Ready'
}

export function App() {
  const reduceMotion = useReducedMotion()
  const [state, setState] = useState<IslandSnapshot>(() => createInitialIslandState())
  const [discoveryNote, setDiscoveryNote] = useState('Discovering agents…')
  const dismissTimer = useRef<number | null>(null)

  const dispatch = (event: IslandEvent) => {
    setState((prev) => reduceIsland(prev, event))
  }

  const handleSessionChange = (
    agentId: AgentId,
    info: import('@shared/pty-types').PtySessionInfo | null,
    error?: string
  ) => {
    if (info?.alive) {
      dispatch({
        type: 'SET_AGENT_STATUS',
        agentId,
        status: 'running',
        activityLabel: `pid ${info.pid ?? 'live'}`
      })
      return
    }
    if (error) {
      dispatch({
        type: 'SET_AGENT_STATUS',
        agentId,
        status: error.toLowerCase().includes('unavailable') || error.toLowerCase().includes('not found')
          ? 'offline'
          : 'error',
        activityLabel: error.slice(0, 48),
        lastError: error
      })
    }
  }

  const approval = currentApproval(state)
  const queueCount = pendingApprovalCount(state)
  const active = state.agents[state.activeAgentId]
  const showDemo =
    state.mode === 'peek' ||
    state.mode === 'expanded' ||
    state.mode === 'approval' ||
    state.mode === 'success' ||
    state.mode === 'error'
  const size = useMemo(() => sizeForMode(state.mode, showDemo), [state.mode, showDemo])

  useEffect(() => {
    const api = window.agentIsland
    if (!api) {
      setDiscoveryNote('Bridge offline — reload app')
      return
    }

    void api.discoverAgents().then((result: unknown) => {
      const data = result as {
        agents: Array<{ id: AgentId; available: boolean; path?: string; version?: string; notes?: string }>
      }
      const lines = data.agents.map((agent) => {
        if (!agent.available) return `${agent.id}: missing`
        return `${agent.id}: ${shortActivity(agent.version)}`
      })
      setDiscoveryNote(lines.join(' · '))

      for (const agent of data.agents) {
        dispatch({
          type: 'SET_AGENT_STATUS',
          agentId: agent.id,
          status: agent.available ? 'idle' : 'offline',
          activityLabel: agent.available ? shortActivity(agent.version) : 'Not found'
        })
      }
    })

    const offToggle = api.onToggle(() => {
      setState((prev) =>
        reduceIsland(prev, {
          type: prev.mode === 'collapsed' || prev.mode === 'peek' ? 'EXPAND' : 'COLLAPSE'
        })
      )
    })
    const offSelect = api.onSelectAgent((agentId: AgentId) => {
      dispatch({ type: 'SELECT_AGENT', agentId })
    })

    return () => {
      offToggle()
      offSelect()
    }
  }, [])

  useEffect(() => {
    const api = window.agentIsland
    if (!api) return
    void api.resize(size.width, size.height)
  }, [size.width, size.height])

  useEffect(() => {
    if (state.mode !== 'success' && state.mode !== 'error') return
    if (state.hovered || state.focused) return
    if (dismissTimer.current) window.clearTimeout(dismissTimer.current)
    dismissTimer.current = window.setTimeout(() => {
      dispatch({ type: 'DISMISS_TRANSIENT' })
    }, 1800)
    return () => {
      if (dismissTimer.current) window.clearTimeout(dismissTimer.current)
    }
  }, [state.mode, state.hovered, state.focused, state.message])

  const approveEnabled = approval
    ? canApproveRequest({ request: approval, displayedRequestId: approval.id }).canApprove
    : false

  const onApprove = () => {
    if (!approval) return
    dispatch({ type: 'ANSWER_APPROVAL', requestId: approval.id, decision: 'approve' })
  }

  const onDeny = () => {
    if (!approval) return
    dispatch({ type: 'ANSWER_APPROVAL', requestId: approval.id, decision: 'deny' })
  }

  const simulateApproval = (agentId: AgentId) => {
    const now = Date.now()
    const request: ApprovalRequest = {
      id: `demo-${now}`,
      agentId,
      summary: agentId === 'codex' ? 'Install dependency' : 'Run shell command',
      detail:
        agentId === 'codex'
          ? 'npm install @tanstack/react-query'
          : agentId === 'claude'
            ? 'git push origin main'
            : 'Remove-Item -Recurse node_modules',
      cwd: 'C:\\Users\\OASIS\\Downloads\\agent-island',
      risk: agentId === 'hermes' ? 'high' : agentId === 'codex' ? 'elevated' : 'low',
      riskReason:
        agentId === 'hermes'
          ? 'Destructive recursive delete'
          : agentId === 'codex'
            ? 'Installs packages from the network'
            : 'Pushes local commits',
      createdAt: now,
      expiresAt: now + 5 * 60_000,
      processAlive: true,
      waitingForInput: true,
      answered: false,
      superseded: false
    }
    dispatch({ type: 'ENQUEUE_APPROVAL', request })
  }

  return (
    <div
      className="stage"
      onMouseEnter={() => dispatch({ type: 'HOVER_ENTER' })}
      onMouseLeave={() => dispatch({ type: 'HOVER_LEAVE' })}
    >
      <motion.div
        className="island-frame"
        animate={{ width: size.width, height: size.height - (showDemo ? 62 : 0) }}
        transition={
          reduceMotion
            ? { duration: 0 }
            : { type: 'spring', stiffness: 380, damping: 32, mass: 0.7 }
        }
      >
        <IslandShell
          state={state}
          active={active}
          approval={approval}
          queueCount={queueCount}
          approveEnabled={approveEnabled}
          discoveryNote={discoveryNote}
          onSelectAgent={(agentId) => dispatch({ type: 'SELECT_AGENT', agentId })}
          onClickPill={() => dispatch({ type: 'CLICK_PILL' })}
          onExpand={() => dispatch({ type: 'EXPAND' })}
          onCollapse={() => dispatch({ type: 'COLLAPSE' })}
          onApprove={onApprove}
          onDeny={onDeny}
          onDismiss={() => dispatch({ type: 'DISMISS_TRANSIENT' })}
          onSessionChange={handleSessionChange}
        />
      </motion.div>

      {showDemo && (
        <div className="demo-dock">
          <DemoControls
            agents={AGENT_ORDER}
            onSimulateApproval={simulateApproval}
            onThinking={() =>
              dispatch({
                type: 'SET_AGENT_STATUS',
                agentId: state.activeAgentId,
                status: 'thinking',
                activityLabel: 'Thinking…'
              })
            }
            onRunning={() =>
              dispatch({
                type: 'SET_AGENT_STATUS',
                agentId: state.activeAgentId,
                status: 'running',
                activityLabel: 'Editing files…'
              })
            }
            onComplete={() => dispatch({ type: 'COMPLETE', message: 'Task finished' })}
            onError={() =>
              dispatch({ type: 'SET_ERROR', message: 'Agent process exited unexpectedly' })
            }
          />
        </div>
      )}
    </div>
  )
}
