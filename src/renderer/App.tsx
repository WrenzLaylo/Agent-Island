import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AGENT_ORDER,
  type AgentId,
  type ApprovalRequest,
  type DockSide,
  type IslandSnapshot,
  type IslandWindowLayout
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

const HOVER_OPEN_MS = 900

function sizeForMode(
  mode: IslandSnapshot['mode'],
  queueCount: number,
  docked: DockSide | null
): { width: number; height: number } {
  if (mode === 'collapsed' && docked) return { width: 62, height: 62 }

  switch (mode) {
    case 'collapsed':
      return { width: queueCount > 0 ? 340 : 318, height: 66 }
    case 'peek':
    case 'success':
    case 'expanded':
      return { width: 404, height: 154 }
    case 'error':
      return { width: 404, height: 166 }
    case 'approval':
      return { width: 440, height: 322 }
    default:
      return { width: 318, height: 66 }
  }
}

interface DragState {
  active: boolean
  pointerId: number
  target: Element
  startX: number
  startY: number
  originX: number
  originY: number
  moved: boolean
}

export function App() {
  const [state, setState] = useState<IslandSnapshot>(() => createInitialIslandState())
  const [statusNote, setStatusNote] = useState('Starting bridge…')
  const [docked, setDocked] = useState<DockSide | null>(null)
  const [attentionNonce, setAttentionNonce] = useState(0)
  const dismissTimer = useRef<number | null>(null)
  const hoverTimer = useRef<number | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const suppressClickRef = useRef(false)
  const pendingPointerRef = useRef<number | null>(null)

  const dispatch = (event: IslandEvent) => {
    setState((previous) => reduceIsland(previous, event))
  }

  const approval = currentApproval(state)
  const queueCount = pendingApprovalCount(state)
  const active = state.agents[state.activeAgentId]
  const size = useMemo(
    () => sizeForMode(state.mode, queueCount, docked),
    [state.mode, queueCount, docked]
  )

  useEffect(() => {
    const api = window.agentIsland
    if (!api) {
      setStatusNote('Bridge offline — reload app')
      return
    }

    void api.getLayout?.().then((layout: IslandWindowLayout) => {
      setDocked(layout.docked)
    })

    // Mark Hermes as the listening target (no local PTY).
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
      const hermes = data.agents?.find((agent) => agent.id === 'hermes')
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
        setStatusNote('Hermes not found — install or sign in to activate the bridge')
      }
    })

    const enqueueApproval = (request: ApprovalRequest) => {
      if (!request?.id || !request.agentId) return
      setAttentionNonce((value) => value + 1)
      dispatch({ type: 'ENQUEUE_APPROVAL', request })
    }

    const offApproval = api.onApproval?.((request: unknown) => {
      enqueueApproval(request as ApprovalRequest)
    })

    const offApprovalCleared = api.onApprovalCleared?.((request: unknown) => {
      const cleared = request as ApprovalRequest
      if (!cleared?.id) return
      setState((previous) => {
        const existing = previous.approvals[cleared.id]
        if (!existing || existing.answered) return previous
        return reduceIsland(previous, {
          type: 'ANSWER_APPROVAL',
          requestId: cleared.id,
          decision: 'deny'
        })
      })
    })

    const offToggle = api.onToggle?.(() => {
      setState((previous) =>
        reduceIsland(previous, {
          type: previous.mode === 'collapsed' ? 'CLICK_PILL' : 'COLLAPSE'
        })
      )
    })

    // Pull any already-pending bridge items.
    void api.listBridgeApprovals?.().then((items: unknown) => {
      const list = items as ApprovalRequest[]
      if (!Array.isArray(list)) return
      for (const request of list) enqueueApproval(request)
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
    }, 1800)
    return () => {
      if (dismissTimer.current) window.clearTimeout(dismissTimer.current)
    }
  }, [state.mode, state.hovered, state.focused, state.message])

  // A real approval always overrides compact mode and expands automatically.
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
    if (state.mode === 'collapsed' && !dragRef.current?.active) {
      hoverTimer.current = window.setTimeout(() => {
        dispatch({ type: 'HOVER_OPEN' })
      }, HOVER_OPEN_MS)
    }
  }

  const onMouseLeave = () => {
    if (dragRef.current?.active) return
    clearHoverTimer()
    dispatch({ type: 'HOVER_LEAVE' })
  }

  // Smooth manual drag. The renderer streams movement, then Electron decides whether to dock.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current
      const api = window.agentIsland
      if (!drag?.active || !api?.moveWindow) return

      const deltaX = event.screenX - drag.startX
      const deltaY = event.screenY - drag.startY
      if (Math.abs(deltaX) + Math.abs(deltaY) > 4) drag.moved = true
      if (!drag.moved) return

      api.moveWindow(drag.originX + deltaX, drag.originY + deltaY)
    }

    const onUp = (event: PointerEvent) => {
      if (pendingPointerRef.current === event.pointerId) pendingPointerRef.current = null
      const drag = dragRef.current
      const api = window.agentIsland
      if (!drag?.active || event.pointerId !== drag.pointerId) return

      drag.active = false
      try {
        drag.target.releasePointerCapture(drag.pointerId)
      } catch {
        // Pointer capture may already be released when the OS changes displays.
      }

      if (!drag.moved || !api) {
        dragRef.current = null
        return
      }

      suppressClickRef.current = true
      const finalX = drag.originX + (event.screenX - drag.startX)
      const finalY = drag.originY + (event.screenY - drag.startY)
      dragRef.current = null

      void (async () => {
        try {
          await api.setPosition(finalX, finalY)
          const layout = await api.finishDrag()
          setDocked(layout.docked)
        } finally {
          window.setTimeout(() => {
            suppressClickRef.current = false
          }, 0)
        }
      })()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  useEffect(() => {
    const onDown = async (event: PointerEvent) => {
      if (event.button !== 0) return
      const target = event.target as Element | null
      if (!target?.closest?.('[data-drag-region="true"]')) return
      if (target.closest('[data-no-drag="true"]')) return

      clearHoverTimer()
      pendingPointerRef.current = event.pointerId
      const api = window.agentIsland
      if (!api?.getBounds) return
      const bounds = await api.getBounds()
      if (!bounds || pendingPointerRef.current !== event.pointerId) return

      try {
        target.setPointerCapture(event.pointerId)
      } catch {
        // Capture is best-effort; window movement still works without it.
      }

      dragRef.current = {
        active: true,
        pointerId: event.pointerId,
        target,
        startX: event.screenX,
        startY: event.screenY,
        originX: bounds.x,
        originY: bounds.y,
        moved: false
      }
    }

    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [])

  const onClickPill = () => {
    if (suppressClickRef.current) return
    dispatch({ type: 'CLICK_PILL' })
  }

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
          docked={docked}
          attentionNonce={attentionNonce}
          onSelectAgent={(agentId) => dispatch({ type: 'SELECT_AGENT', agentId })}
          onClickPill={onClickPill}
          onCollapse={() => dispatch({ type: 'COLLAPSE' })}
          onApprove={() => void onApprove()}
          onDeny={() => void onDeny()}
          onDismiss={() => dispatch({ type: 'DISMISS_TRANSIENT' })}
        />
      </div>
    </div>
  )
}
