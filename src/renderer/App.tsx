import { useEffect, useMemo, useRef, useState } from 'react'
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

const HOVER_OPEN_MS = 1000

function sizeForMode(mode: IslandSnapshot['mode'], queueCount: number): { width: number; height: number } {
  switch (mode) {
    case 'collapsed':
      return { width: queueCount > 0 ? 280 : 250, height: 52 }
    case 'peek':
    case 'success':
      return { width: 420, height: 140 }
    case 'error':
      return { width: 420, height: 150 }
    case 'approval':
      return { width: 520, height: 280 }
    case 'expanded':
      // No terminal expand — treat as peek.
      return { width: 420, height: 140 }
    default:
      return { width: 250, height: 52 }
  }
}

export function App() {
  const [state, setState] = useState<IslandSnapshot>(() => createInitialIslandState())
  const [statusNote, setStatusNote] = useState('Starting bridge…')
  const dismissTimer = useRef<number | null>(null)
  const hoverTimer = useRef<number | null>(null)
  const dragRef = useRef<{
    active: boolean
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
  } | null>(null)

  const dispatch = (event: IslandEvent) => {
    setState((prev) => reduceIsland(prev, event))
  }

  const approval = currentApproval(state)
  const queueCount = pendingApprovalCount(state)
  const active = state.agents[state.activeAgentId]
  const size = useMemo(() => sizeForMode(state.mode, queueCount), [state.mode, queueCount])

  useEffect(() => {
    const api = window.agentIsland
    if (!api) {
      setStatusNote('Bridge offline — reload app')
      return
    }

    // Mark Hermes as listening target (no local PTY).
    for (const id of AGENT_ORDER) {
      dispatch({
        type: 'SET_AGENT_STATUS',
        agentId: id,
        status: id === 'hermes' ? 'idle' : 'offline',
        activityLabel: id === 'hermes' ? 'Bridge ready' : 'Not connected',
        available: id === 'hermes',
        integrationMode: id === 'hermes' ? 'structured' : 'unavailable'
      })
    }

    void api.discoverAgents?.().then((result: unknown) => {
      const data = result as { agents?: Array<{ id: AgentId; available: boolean; version?: string }> }
      const hermes = data.agents?.find((a) => a.id === 'hermes')
      if (hermes?.available) {
        setStatusNote(`Hermes bridge active${hermes.version ? ` · ${hermes.version}` : ''}`)
        dispatch({
          type: 'SET_AGENT_STATUS',
          agentId: 'hermes',
          status: 'idle',
          activityLabel: 'Listening',
          available: true,
          integrationMode: 'structured'
        })
      } else {
        setStatusNote('Hermes not found — install/login still required for bridge')
      }
    })

    const offApproval = api.onApproval?.((request: unknown) => {
      const req = request as ApprovalRequest
      if (!req?.id || !req.agentId) return
      dispatch({ type: 'ENQUEUE_APPROVAL', request: req })
    })
    const offApprovalCleared = api.onApprovalCleared?.((request: unknown) => {
      const req = request as ApprovalRequest
      if (!req?.id) return
      setState((prev) => {
        const existing = prev.approvals[req.id]
        if (!existing || existing.answered) return prev
        return reduceIsland(prev, {
          type: 'ANSWER_APPROVAL',
          requestId: req.id,
          decision: 'deny'
        })
      })
    })
    const offToggle = api.onToggle?.(() => {
      setState((prev) =>
        reduceIsland(prev, {
          type: prev.mode === 'collapsed' ? 'CLICK_PILL' : 'COLLAPSE'
        })
      )
    })

    // Pull any already-pending bridge items.
    void api.listBridgeApprovals?.().then((items: unknown) => {
      const list = items as ApprovalRequest[]
      if (!Array.isArray(list)) return
      for (const req of list) {
        if (req?.id) dispatch({ type: 'ENQUEUE_APPROVAL', request: req })
      }
    })

    return () => {
      offApproval?.()
      offApprovalCleared?.()
      offToggle?.()
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
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
    }, 1600)
    return () => {
      if (dismissTimer.current) window.clearTimeout(dismissTimer.current)
    }
  }, [state.mode, state.hovered, state.focused, state.message])

  // Auto-open when a real approval arrives.
  useEffect(() => {
    if (queueCount > 0 && state.mode === 'collapsed') {
      dispatch({ type: 'EXPAND' })
    }
  }, [queueCount, state.mode])

  const approveEnabled = approval
    ? canApproveRequest({ request: approval, displayedRequestId: approval.id }).canApprove
    : false

  const onApprove = async () => {
    if (!approval) return
    const api = window.agentIsland
    if (approval.source === 'hermes-terminal' && api?.answerBridgeApproval) {
      const result = await api.answerBridgeApproval({
        requestId: approval.id,
        decision: 'approve'
      })
      if (!result.ok) {
        dispatch({ type: 'SET_ERROR', message: result.error ?? 'Approve failed' })
        return
      }
    }
    dispatch({ type: 'ANSWER_APPROVAL', requestId: approval.id, decision: 'approve' })
  }

  const onDeny = async () => {
    if (!approval) return
    const api = window.agentIsland
    if (approval.source === 'hermes-terminal' && api?.answerBridgeApproval) {
      const result = await api.answerBridgeApproval({
        requestId: approval.id,
        decision: 'deny'
      })
      if (!result.ok) {
        dispatch({ type: 'SET_ERROR', message: result.error ?? 'Deny failed' })
        return
      }
    }
    dispatch({ type: 'ANSWER_APPROVAL', requestId: approval.id, decision: 'deny' })
  }

  const clearHoverTimer = () => {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }

  const onMouseEnter = () => {
    dispatch({ type: 'HOVER_ENTER' })
    clearHoverTimer()
    if (state.mode === 'collapsed') {
      hoverTimer.current = window.setTimeout(() => {
        dispatch({ type: 'HOVER_OPEN' })
      }, HOVER_OPEN_MS)
    }
  }

  const onMouseLeave = () => {
    clearHoverTimer()
    dispatch({ type: 'HOVER_LEAVE' })
  }

  // Manual drag (Windows-friendly; does not steal clicks from buttons).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      const api = window.agentIsland
      if (!drag?.active || !api?.setPosition || !api.getBounds) return
      const dx = e.screenX - drag.startX
      const dy = e.screenY - drag.startY
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
      void api.setPosition(drag.originX + dx, drag.originY + dy)
    }
    const onUp = () => {
      if (dragRef.current) dragRef.current.active = false
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  useEffect(() => {
    const onDown = async (e: PointerEvent) => {
      const target = e.target as HTMLElement | null
      if (!target?.closest?.('.drag-handle')) return
      e.preventDefault()
      const api = window.agentIsland
      if (!api?.getBounds) return
      const bounds = await api.getBounds()
      if (!bounds) return
      dragRef.current = {
        active: true,
        startX: e.screenX,
        startY: e.screenY,
        originX: bounds.x,
        originY: bounds.y,
        moved: false
      }
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [])

  return (
    <div className="stage" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="island-frame fill">
        <IslandShell
          state={state}
          active={active}
          approval={approval}
          queueCount={queueCount}
          approveEnabled={approveEnabled}
          statusNote={statusNote}
          onSelectAgent={(agentId) => dispatch({ type: 'SELECT_AGENT', agentId })}
          onClickPill={() => dispatch({ type: 'CLICK_PILL' })}
          onCollapse={() => dispatch({ type: 'COLLAPSE' })}
          onApprove={() => void onApprove()}
          onDeny={() => void onDeny()}
          onDismiss={() => dispatch({ type: 'DISMISS_TRANSIENT' })}
        />
      </div>
    </div>
  )
}
