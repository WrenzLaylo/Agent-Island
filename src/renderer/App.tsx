import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AGENT_ORDER,
  DEFAULT_ISLAND_SETTINGS,
  type AgentId,
  type ApprovalDecision,
  type ApprovalRequest,
  type DockSide,
  type IslandSettings,
  type IslandSnapshot,
  type IslandWindowLayout,
  type TerminalInputPrompt
} from '@shared/contracts'
import {
  createInitialIslandState,
  currentApproval,
  pendingApprovalCount,
  reduceIsland,
  type IslandEvent
} from '@shared/island-machine'
import { canApproveRequest } from '@shared/approval-guard'
import type { AgentSessionRecord, SessionPromptRecord } from '@shared/session-registry'
import { IslandShell, type IslandPanel } from './components/IslandShell'

function isVisibleActivity(status: IslandSnapshot['agents'][AgentId]['status']): boolean {
  return status === 'running' || status === 'thinking' || status === 'waiting' || status === 'completed' || status === 'error'
}

/**
 * Window size == visible size. There is no native mask and no frame inset any
 * more, so these are the literal pixels the user sees. Everything sits on a
 * 4px grid so the shell never lands on a half-pixel at fractional DPI.
 */
function sizeForPresentation(
  mode: IslandSnapshot['mode'],
  docked: DockSide | null,
  approvalChoiceCount: number,
  panel: IslandPanel,
  quietIdle: boolean
): { width: number; height: number } {
  if (panel === 'settings') return { width: 440, height: 600 }
  if (panel === 'onboarding') return { width: 400, height: 380 }
  if (panel === 'handoff') return { width: 392, height: 196 }
  if (mode === 'collapsed' && docked) return quietIdle ? { width: 36, height: 36 } : { width: 48, height: 48 }

  switch (mode) {
    case 'collapsed':
      return quietIdle ? { width: 116, height: 32 } : { width: 300, height: 52 }
    case 'peek':
    case 'expanded':
      return { width: 400, height: 172 }
    case 'success':
      return { width: 340, height: 96 }
    case 'error':
      return { width: 372, height: 108 }
    case 'approval':
      return {
        width: 440,
        height: approvalChoiceCount >= 4 ? 516 : approvalChoiceCount === 3 ? 460 : 404
      }
    default:
      return quietIdle ? { width: 116, height: 32 } : { width: 300, height: 52 }
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

function playApprovalCue(): void {
  try {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) return
    const context = new AudioContextClass()
    const gain = context.createGain()
    const oscillator = context.createOscillator()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(520, context.currentTime)
    oscillator.frequency.exponentialRampToValueAtTime(690, context.currentTime + 0.12)
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.055, context.currentTime + 0.018)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.24)
    oscillator.addEventListener('ended', () => void context.close())
  } catch {
    // Audio is optional and may be blocked by OS policy.
  }
}


/**
 * A session prompt is the registry's wire format; the island's state machine
 * speaks ApprovalRequest / TerminalInputPrompt. `id` is the prompt id so the
 * decision written back to the wrapper matches what it is waiting on.
 */
function sessionPromptToApproval(
  prompt: SessionPromptRecord,
  session: AgentSessionRecord
): ApprovalRequest {
  return {
    id: prompt.promptId,
    agentId: prompt.agentId,
    summary: prompt.title,
    detail: prompt.detail,
    cwd: prompt.cwd || session.cwd,
    risk: prompt.risk ?? 'unknown',
    riskReason: prompt.riskReason,
    createdAt: prompt.createdAt,
    expiresAt: prompt.expiresAt,
    processAlive: true,
    waitingForInput: true,
    answered: false,
    superseded: false,
    // Every agent gets its own source. This used to fall through to
    // 'codex-terminal' for anything that was not Hermes, so Claude approvals
    // were rendered with Codex's wording.
    source: `${prompt.agentId}-terminal` as ApprovalRequest['source'],
    fingerprint: prompt.fingerprint,
    choices: prompt.choices,
    sessionId: session.id
  }
}

function sessionPromptToHandoff(
  prompt: SessionPromptRecord,
  session: AgentSessionRecord
): TerminalInputPrompt {
  return {
    id: prompt.promptId,
    agentId: prompt.agentId,
    kind: 'unsupported',
    title: prompt.title,
    detail: prompt.detail,
    cwd: prompt.cwd || session.cwd,
    createdAt: prompt.createdAt,
    expiresAt: prompt.expiresAt,
    processAlive: true,
    waitingForInput: true,
    fingerprint: prompt.fingerprint,
    sessionId: session.id,
    terminalLabel: session.terminalLabel,
    canRaiseWindow: session.hwnd != null
  }
}

export function App() {
  const [state, setState] = useState<IslandSnapshot>(() => createInitialIslandState())
  const [settings, setSettings] = useState<IslandSettings>(DEFAULT_ISLAND_SETTINGS)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [statusNote, setStatusNote] = useState('Discovering agents…')
  const [docked, setDocked] = useState<DockSide | null>(null)
  const [attentionNonce, setAttentionNonce] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [isMorphing, setIsMorphing] = useState(false)
  const [panel, setPanel] = useState<IslandPanel>(null)
  const [terminalInput, setTerminalInput] = useState<TerminalInputPrompt | null>(null)
  const [windowFocused, setWindowFocused] = useState(false)

  const stateRef = useRef(state)
  const settingsRef = useRef(settings)
  const dismissTimer = useRef<number | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const suppressClickRef = useRef(false)
  const pendingPointerRef = useRef<number | null>(null)
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null)
  const moveRafRef = useRef<number | null>(null)
  const resizeRunRef = useRef(0)
  const soundedApprovals = useRef(new Set<string>())
  const completionTimers = useRef<Partial<Record<AgentId, number>>>({})
  const sessionsRef = useRef<AgentSessionRecord[]>([])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  const dispatch = (event: IslandEvent) => {
    setState((previous) => reduceIsland(previous, event))
  }

  const approval = currentApproval(state)
  const queueCount = pendingApprovalCount(state)
  const selectedActive = state.agents[state.activeAgentId]
  const activityAgent = isVisibleActivity(selectedActive.status)
    ? selectedActive
    : AGENT_ORDER.map((id) => state.agents[id]).find((agent) => isVisibleActivity(agent.status))
  const active =
    state.mode === 'collapsed' && panel === null && queueCount === 0 && activityAgent
      ? activityAgent
      : selectedActive
  const quietIdle =
    settings.quietIdle &&
    state.mode === 'collapsed' &&
    panel === null &&
    queueCount === 0 &&
    !activityAgent
  const size = useMemo(
    () => sizeForPresentation(state.mode, docked, approval?.choices?.length ?? 2, panel, quietIdle),
    [state.mode, docked, approval?.choices?.length, panel, quietIdle]
  )

  useEffect(() => {
    const api = window.agentIsland
    if (!api) {
      setStatusNote('Bridge offline — reload Agent Island')
      return
    }

    let disposed = false

    void api.getSettings().then((loaded: IslandSettings) => {
      if (disposed) return
      setSettings(loaded)
      settingsRef.current = loaded
      setSettingsLoaded(true)
      if (loaded.rememberLastAgent) {
        dispatch({ type: 'SELECT_AGENT', agentId: loaded.lastAgentId, open: false })
      }
      if (!loaded.onboardingComplete) setPanel('onboarding')
    })

    void api.getLayout().then((layout: IslandWindowLayout) => {
      if (!disposed) setDocked(layout.docked)
    })

    const applyDiscovery = (result: unknown) => {
      const data = result as {
        agents?: Array<{
          id: AgentId
          available: boolean
          version?: string
          integrationMode?: IslandSnapshot['agents'][AgentId]['integrationMode']
        }>
      }
      const discovered = data.agents ?? []
      const availableNames: string[] = []
      for (const id of AGENT_ORDER) {
        const item = discovered.find((agent) => agent.id === id)
        const available = Boolean(item?.available)
        if (available) availableNames.push(stateRef.current.agents[id].label)
        dispatch({
          type: 'SET_AGENT_STATUS',
          agentId: id,
          status: available ? 'idle' : 'offline',
          activityLabel: available
            ? id === 'hermes'
              ? 'Listening for approvals'
              : 'Installed and ready'
            : 'Not detected',
          available,
          integrationMode:
            id === 'hermes' && available ? 'structured' : item?.integrationMode ?? 'unavailable',
          version: item?.version
        })
      }
      setStatusNote(
        availableNames.length
          ? `${availableNames.join(', ')} detected`
          : 'No supported agents were detected'
      )

      const currentAgent = stateRef.current.activeAgentId
      const currentAvailable = discovered.find((agent) => agent.id === currentAgent)?.available
      const firstAvailable = AGENT_ORDER.find((id) => discovered.some((agent) => agent.id === id && agent.available))
      if (!currentAvailable && firstAvailable && stateRef.current.approvalQueue.length === 0) {
        dispatch({ type: 'SELECT_AGENT', agentId: firstAvailable, open: false })
        if (settingsRef.current.rememberLastAgent) {
          void api.updateSettings({ lastAgentId: firstAvailable })
        }
      }
    }

    void api.discoverAgents().then(applyDiscovery)

    const enqueueApproval = (request: ApprovalRequest, playSound = true, mayExpand = true) => {
      if (!request?.id || !request.agentId) return
      const autoExpand = mayExpand && settingsRef.current.autoExpandApprovals
      if (autoExpand) setPanel(null)
      setAttentionNonce((value) => value + 1)
      dispatch({
        type: 'ENQUEUE_APPROVAL',
        request,
        autoExpand
      })
      if (
        playSound &&
        settingsRef.current.approvalSounds &&
        !soundedApprovals.current.has(request.id)
      ) {
        soundedApprovals.current.add(request.id)
        playApprovalCue()
      }
    }

    const offApproval = api.onApproval((request: unknown) => enqueueApproval(request as ApprovalRequest))

    const offApprovalCleared = api.onApprovalCleared((request: unknown) => {
      const cleared = request as ApprovalRequest
      if (!cleared?.id) return
      const message = !cleared.processAlive
        ? 'The agent closed before this request was answered.'
        : cleared.superseded
          ? 'The command changed or the approval was handled elsewhere.'
          : 'The approval request is no longer active.'
      dispatch({
        type: 'INVALIDATE_APPROVAL',
        requestId: cleared.id,
        message,
        kind: 'cancelled'
      })
    })

    const offToggle = api.onToggle(() => {
      setPanel(null)
      setState((previous) =>
        reduceIsland(previous, {
          type: previous.mode === 'collapsed' ? 'CLICK_PILL' : 'COLLAPSE'
        })
      )
    })

    const offSelectAgent = api.onSelectAgent((agentId: AgentId) => {
      setPanel(null)
      dispatch({ type: 'SELECT_AGENT', agentId })
    })

    const offSettings = api.onSettingsChanged((next: IslandSettings) => {
      setSettings(next)
      settingsRef.current = next
    })

    const offOpenSettings = api.onOpenSettings(() => {
      setPanel('settings')
      dispatch({ type: 'EXPAND' })
    })

    const offReturnHome = api.onReturnHome(() => {
      setDocked(null)
      setPanel(null)
      dispatch({ type: 'COLLAPSE' })
    })

    const offWindowFocus = api.onWindowFocus((focused: boolean) => setWindowFocused(focused))

    const offOutsideClick = api.onOutsideClick(() => {
      if (dragRef.current?.active) return
      setPanel(null)
      dispatch({ type: 'COLLAPSE' })
    })

    const offTerminalInput = api.onTerminalInput((request: TerminalInputPrompt) => {
      if (!request?.id || !request.agentId) return
      setTerminalInput(request)
      setAttentionNonce((value) => value + 1)
      setPanel('handoff')
      dispatch({ type: 'SELECT_AGENT', agentId: request.agentId, open: false })
      dispatch({
        type: 'SET_AGENT_STATUS',
        agentId: request.agentId,
        status: 'waiting',
        activityLabel: 'Needs input in terminal',
        available: true
      })
      dispatch({ type: 'EXPAND' })
      if (settingsRef.current.approvalSounds) playApprovalCue()
    })

    const offTerminalInputCleared = api.onTerminalInputCleared((request: TerminalInputPrompt) => {
      setTerminalInput((current) => {
        if (!current || current.id !== request.id) return current
        return null
      })
      setPanel((current) => current === 'handoff' ? null : current)
      const agent = stateRef.current.agents[request.agentId]
      if (agent?.available && agent.pendingApprovalIds.length === 0) {
        dispatch({
          type: 'SET_AGENT_STATUS',
          agentId: request.agentId,
          status: 'running',
          activityLabel: 'Session running',
          available: true
        })
      }
    })

    // Sessions come from `island <agent>` wrappers running in real terminals.
    // Agent Island owns no processes, so "running" here means "a wrapper for
    // this agent is alive", nothing more.
    const applySessions = (sessions: AgentSessionRecord[]) => {
      sessionsRef.current = sessions
      for (const id of AGENT_ORDER) {
        const live = sessions.filter((s) => s.agentId === id)
        const agent = stateRef.current.agents[id]
        if (!agent.available) continue
        if (agent.pendingApprovalIds.length > 0) continue
        dispatch({
          type: 'SET_AGENT_STATUS',
          agentId: id,
          status: live.length ? 'running' : 'idle',
          activityLabel: live.length
            ? live.length > 1
              ? `${live.length} sessions in terminals`
              : `Running in ${live[0].terminalLabel}`
            : 'No session running',
          available: true
        })
      }
    }

    const refreshSessions = () => {
      void api.listSessions().then((list) => {
        if (!disposed && Array.isArray(list)) applySessions(list)
      })
    }

    const offSessionAdded = api.onSessionAdded(() => refreshSessions())
    const offSessionRemoved = api.onSessionRemoved((session) => {
      // If the terminal hosting the current handoff disappeared, stop offering
      // to switch to it.
      setTerminalInput((current) => (current && current.id.startsWith(session.id) ? null : current))
      setPanel((current) => (current === 'handoff' ? null : current))
      refreshSessions()
    })

    const offSessionPrompt = api.onSessionPrompt(({ prompt, session, terminalFocused }) => {
      // The user is already in the terminal that asked. Track the prompt so the
      // pill reflects it, but do not open over the thing they are reading.
      if (prompt.kind === 'approval') {
        enqueueApproval(sessionPromptToApproval(prompt, session), true, !terminalFocused)
        return
      }
      setTerminalInput(sessionPromptToHandoff(prompt, session))
      setAttentionNonce((value) => value + 1)
      if (!terminalFocused) setPanel('handoff')
      dispatch({ type: 'SELECT_AGENT', agentId: prompt.agentId, open: false })
      dispatch({
        type: 'SET_AGENT_STATUS',
        agentId: prompt.agentId,
        status: 'waiting',
        activityLabel: `Needs input in ${session.terminalLabel}`,
        available: true
      })
      if (!terminalFocused) dispatch({ type: 'EXPAND' })
      if (settingsRef.current.approvalSounds) playApprovalCue()
    })

    const offSessionPromptCleared = api.onSessionPromptCleared((prompt) => {
      if (prompt.kind === 'approval') {
        dispatch({
          type: 'INVALIDATE_APPROVAL',
          requestId: prompt.promptId,
          message: 'The agent moved on before this was answered.',
          kind: 'cancelled'
        })
        return
      }
      setTerminalInput((current) => (current?.id === prompt.promptId ? null : current))
      setPanel((current) => (current === 'handoff' ? null : current))
      refreshSessions()
    })

    refreshSessions()
    void api.listSessionPrompts().then((list) => {
      if (disposed || !Array.isArray(list)) return
      for (const prompt of list) {
        const session = sessionsRef.current.find((item: AgentSessionRecord) => item.id === prompt.sessionId)
        if (!session) continue
        if (prompt.kind === 'approval') {
          enqueueApproval(sessionPromptToApproval(prompt, session), false)
        } else {
          setTerminalInput(sessionPromptToHandoff(prompt, session))
          setPanel('handoff')
          dispatch({ type: 'EXPAND' })
        }
      }
    })

    void api.listBridgeApprovals().then((items: unknown) => {
      const list = items as ApprovalRequest[]
      if (!Array.isArray(list)) return
      for (const request of list) enqueueApproval(request, false)
    })

    return () => {
      disposed = true
      offApproval()
      offApprovalCleared()
      offToggle()
      offSelectAgent()
      offSettings()
      offOpenSettings()
      offReturnHome()
      offOutsideClick()
      offWindowFocus()
      offTerminalInput()
      offTerminalInputCleared()
      offSessionAdded()
      offSessionRemoved()
      offSessionPrompt()
      offSessionPromptCleared()
      for (const timer of Object.values(completionTimers.current)) {
        if (timer) window.clearTimeout(timer)
      }
    }
  }, [])

  useEffect(() => {
    if (!settingsLoaded) return
    const api = window.agentIsland
    if (!api) return
    const run = ++resizeRunRef.current
    setIsMorphing(true)
    // A rejected resize must still release the morph lock, otherwise every
    // control in the island stays permanently inert behind `is-morphing`.
    void api
      .resize(size.width, size.height)
      .catch((error: unknown) => {
        console.error('Island resize failed:', error)
      })
      .finally(() => {
        if (resizeRunRef.current === run) setIsMorphing(false)
      })
  }, [size.width, size.height, settingsLoaded])

  /**
   * Retract an island that opened without being asked for.
   *
   * "Click outside to collapse" rides on the window's blur event, and a window
   * that never held focus never blurs — so anything that expanded in the
   * background used to sit there until you clicked it *and then* clicked away.
   * If the island is open, unfocused and the pointer is not on it, nobody is
   * using it, so it goes back to the pill on its own.
   *
   * Deliberate opens are unaffected: clicking the pill focuses the window, and
   * the global shortcut and attention prompts now take focus too.
   */
  const isExpandedPresentation = state.mode !== 'collapsed' || panel !== null
  useEffect(() => {
    if (!isExpandedPresentation) return
    if (windowFocused || state.hovered || isDragging) return
    const timer = window.setTimeout(() => {
      if (dragRef.current?.active) return
      setPanel(null)
      dispatch({ type: 'COLLAPSE' })
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [isExpandedPresentation, windowFocused, state.hovered, isDragging])

  useEffect(() => {
    if (state.mode !== 'success' && state.mode !== 'error') return
    if (state.approvalQueue.length > 0) return
    if (dismissTimer.current) window.clearTimeout(dismissTimer.current)
    const delay = state.mode === 'success' ? settings.autoCollapseMs : Math.max(1500, settings.autoCollapseMs)
    dismissTimer.current = window.setTimeout(() => dispatch({ type: 'DISMISS_TRANSIENT' }), delay)
    return () => {
      if (dismissTimer.current) window.clearTimeout(dismissTimer.current)
    }
  }, [state.mode, state.message, state.approvalQueue.length, settings.autoCollapseMs])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const snapshot = stateRef.current
      const now = Date.now()
      for (const requestId of snapshot.approvalQueue) {
        const request = snapshot.approvals[requestId]
        if (request && !request.answered && now > request.expiresAt) {
          dispatch({
            type: 'INVALIDATE_APPROVAL',
            requestId,
            message: 'This approval expired before a decision was made.',
            kind: 'expired'
          })
          break
        }
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  const approveEnabled = approval
    ? canApproveRequest({ request: approval, displayedRequestId: approval.id }).canApprove
    : false

  const onDecision = async (decision: ApprovalDecision) => {
    if (!approval || isMorphing) return
    const api = window.agentIsland
    if (approval.source === 'hermes-bridge' && api?.answerBridgeApproval) {
      const result = await api.answerBridgeApproval({ requestId: approval.id, decision })
      if (!result.ok) {
        dispatch({ type: 'SET_ERROR', message: result.error ?? 'The decision could not be written.' })
        return
      }
    } else if (approval.sessionId) {
      const result = await api.answerSessionPrompt({
        sessionId: approval.sessionId,
        promptId: approval.id,
        decision
      })
      if (!result.ok) {
        dispatch({ type: 'SET_ERROR', message: result.error ?? 'The agent no longer accepts this decision.' })
        return
      }
    }
    dispatch({ type: 'ANSWER_APPROVAL', requestId: approval.id, decision })
  }

  const updateAppSettings = (patch: Partial<IslandSettings>) => {
    const optimistic = { ...settingsRef.current, ...patch }
    setSettings(optimistic)
    settingsRef.current = optimistic
    void window.agentIsland.updateSettings(patch).then((saved: IslandSettings) => {
      setSettings(saved)
      settingsRef.current = saved
    })
  }

  const selectAgent = (agentId: AgentId) => {
    dispatch({ type: 'SELECT_AGENT', agentId })
    if (settingsRef.current.rememberLastAgent) updateAppSettings({ lastAgentId: agentId })
  }

  const completeOnboarding = () => {
    updateAppSettings({ onboardingComplete: true })
    setPanel(null)
    dispatch({ type: 'COLLAPSE' })
    // Shell integration is on by default for new installs: without it the
    // island cannot see a session at all. The shims fail open, and Settings has
    // a one-click Remove.
    void window.agentIsland.installShims().then((result) => {
      if (result.ok) updateAppSettings({ shellShimsInstalled: true })
    })
  }

  const onMouseEnter = () => {
    dispatch({ type: 'HOVER_ENTER' })
  }

  const onMouseLeave = () => {
    if (dragRef.current?.active) return
    dispatch({ type: 'HOVER_LEAVE' })
  }

  useEffect(() => {
    const flushMove = () => {
      moveRafRef.current = null
      const drag = dragRef.current
      const pending = pendingMoveRef.current
      if (!drag?.active || !pending) return
      window.agentIsland.moveWindow(pending.x, pending.y)
    }

    const scheduleMove = (x: number, y: number) => {
      pendingMoveRef.current = { x, y }
      if (moveRafRef.current == null) moveRafRef.current = requestAnimationFrame(flushMove)
    }

    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag?.active) return
      const deltaX = event.screenX - drag.startX
      const deltaY = event.screenY - drag.startY
      if (!drag.moved && Math.abs(deltaX) + Math.abs(deltaY) > 4) {
        drag.moved = true
        setIsDragging(true)
      }
      if (!drag.moved) return
      scheduleMove(drag.originX + deltaX, drag.originY + deltaY)
    }

    const onUp = (event: PointerEvent) => {
      if (pendingPointerRef.current === event.pointerId) pendingPointerRef.current = null
      const drag = dragRef.current
      if (!drag?.active || event.pointerId !== drag.pointerId) return
      drag.active = false
      if (moveRafRef.current != null) cancelAnimationFrame(moveRafRef.current)
      moveRafRef.current = null
      pendingMoveRef.current = null
      try {
        drag.target.releasePointerCapture(drag.pointerId)
      } catch {
        // Capture can already be released when moving between displays.
      }

      if (!drag.moved) {
        dragRef.current = null
        setIsDragging(false)
        return
      }

      suppressClickRef.current = true
      const finalX = drag.originX + (event.screenX - drag.startX)
      const finalY = drag.originY + (event.screenY - drag.startY)
      dragRef.current = null

      void (async () => {
        try {
          await window.agentIsland.setPosition(finalX, finalY)
          const layout = await window.agentIsland.finishDrag()
          setDocked(layout.docked)
        } finally {
          setIsDragging(false)
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
      if (moveRafRef.current != null) cancelAnimationFrame(moveRafRef.current)
    }
  }, [])

  useEffect(() => {
    const onDown = async (event: PointerEvent) => {
      if (event.button !== 0) return
      const target = event.target as Element | null
      if (!target?.closest?.('[data-drag-region="true"]')) return
      if (target.closest('[data-no-drag="true"]')) return

      pendingPointerRef.current = event.pointerId
      const bounds = await window.agentIsland.getBounds()
      if (!bounds || pendingPointerRef.current !== event.pointerId) return

      try {
        target.setPointerCapture(event.pointerId)
      } catch {
        // Pointer capture is best effort.
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
    if (terminalInput && stateRef.current.approvalQueue.length === 0) {
      setPanel('handoff')
      dispatch({ type: 'SELECT_AGENT', agentId: terminalInput.agentId, open: false })
      dispatch({ type: 'EXPAND' })
      return
    }
    setPanel(null)
    if (active.id !== stateRef.current.activeAgentId) {
      dispatch({ type: 'SELECT_AGENT', agentId: active.id, open: false })
    }
    dispatch({ type: 'CLICK_PILL' })
  }

  const openTerminal = async (agentId: AgentId, sessionId?: string) => {
    const result = await window.agentIsland.openTerminal({ agentId, sessionId })
    if (!result.ok) {
      dispatch({ type: 'SET_ERROR', message: result.error ?? 'The terminal could not be opened.' })
      return
    }
    // The prompt is still live in the terminal — the user is going there to
    // answer it. Clearing it here just stops the island nagging about it.
    if (terminalInput?.agentId === agentId && (!sessionId || terminalInput.sessionId === sessionId)) {
      setTerminalInput(null)
    }
    setPanel(null)
    dispatch({ type: 'COLLAPSE' })
  }

  const returnHome = async () => {
    const layout = await window.agentIsland.returnHome()
    setDocked(layout.docked)
    setPanel(null)
    dispatch({ type: 'COLLAPSE' })
  }

  return (
    <div
      className={`stage ${isDragging ? 'is-dragging' : ''}`}
      data-reduced-motion={settings.reducedMotion ? 'true' : 'false'}
      data-platform={window.agentIsland?.platform ?? 'unknown'}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="island-frame fill">
        <IslandShell
          state={state}
          active={active}
          approval={approval}
          terminalInput={terminalInput ?? undefined}
          queueCount={queueCount}
          approveEnabled={approveEnabled}
          statusNote={statusNote}
          docked={docked}
          attentionNonce={attentionNonce}
          panel={panel}
          settings={settings}
          isMorphing={isMorphing}
          quietIdle={quietIdle}
          onSelectAgent={selectAgent}
          onClickPill={onClickPill}
          onCollapse={() => {
            setPanel(null)
            dispatch({ type: 'COLLAPSE' })
          }}
          onDecision={(decision) => void onDecision(decision)}
          onContinueInTerminal={(agentId, promptId) => void openTerminal(agentId, promptId)}
          onOpenTerminal={(agentId) => void openTerminal(agentId)}
          onDismiss={() => dispatch({ type: 'DISMISS_TRANSIENT' })}
          onOpenSettings={() => setPanel('settings')}
          onClosePanel={() => setPanel(null)}
          onSettingsChange={updateAppSettings}
          onCompleteOnboarding={completeOnboarding}
          onReturnHome={() => void returnHome()}
        />
      </div>
    </div>
  )
}
