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
import { buildSessionRows } from '@shared/session-list'
import { radiusForSize } from '@shared/surface-radius'
import { IslandShell, type IslandPanel } from './components/IslandShell'

function isVisibleActivity(status: IslandSnapshot['agents'][AgentId]['status']): boolean {
  return status === 'running' || status === 'thinking' || status === 'waiting' || status === 'completed' || status === 'error'
}

/**
 * Session list geometry. These mirror `--session-row-h` and the `gap` on
 * `.session-list` in globals.css — the window is sized from a row count here,
 * so if the CSS changes and these do not, the last row clips.
 */
const SESSION_ROW_H = 38
const SESSION_ROW_GAP = 4
/** Height of the expanded shell above the list: header plus status body. */
const EXPANDED_BASE_H = 148
/** Past this the list scrolls rather than growing the window further. */
const MAX_VISIBLE_SESSION_ROWS = 4
/**
 * The agent switcher strip, which stays visible alongside the session list:
 * 8px padding either side of a 28px control. Selecting an agent that has no
 * session is something only the tabs can do.
 */
const AGENT_TABS_H = 44

/** Choice-card geometry: header, question, text field and terminal link. */
const CHOICE_BASE_H = 236
const CHOICE_ROW_H = 44
const MAX_VISIBLE_CHOICE_ROWS = 4

/**
 * Approval-card geometry: summary row, command block and folder above the
 * option list. One row per option the agent offered, so the height follows
 * that count; past MAX_VISIBLE_APPROVAL_ROWS the list scrolls (see
 * `.decision-list`).
 *
 * The base came down from 292 when the command block lost its "COMMAND"
 * label, its box, and the separate "Flagged" row — that chrome was being
 * reserved for after it no longer existed, leaving a wide band of nothing
 * between the folder and the first option.
 */
const APPROVAL_CHROME_H = 208
/** One line of the command at --fs-lg with 1.45 leading. */
const COMMAND_LINE_H = 22
/** Past this the command scrolls; the options never do. */
const MAX_COMMAND_LINES = 4
/** Monospace characters that fit across the command block at 440px wide. */
const COMMAND_CHARS_PER_LINE = 41

/**
 * Height of the command block, from the command itself.
 *
 * A single constant cannot serve both a one-line command and a wrapped one.
 * Assuming the short case is what pushed the options into a scroll: the window
 * was sized for chrome that had grown, so the overflow landed on the decision
 * list — the one part of this card that must always be reachable without
 * scrolling, because it is the part you act on.
 */
function commandHeight(detail: string): number {
  const text = (detail ?? '').trim()
  if (!text) return COMMAND_LINE_H
  const explicit = text.split('\n')
  const lines = explicit.reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.length / COMMAND_CHARS_PER_LINE)),
    0
  )
  return Math.min(Math.max(lines, 1), MAX_COMMAND_LINES) * COMMAND_LINE_H
}
const APPROVAL_ROW_H = 56
const MAX_VISIBLE_APPROVAL_ROWS = 5

/** Ignore sub-pixel rounding; only a real shortfall should move the window. */
const OVERFLOW_EPSILON = 2
/** However wrong the arithmetic is, the island stays an island. */
const MAX_OVERFLOW_PAD = 260

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
  quietIdle: boolean,
  sessionRowCount: number,
  isChoicePrompt: boolean,
  commandDetailHeight: number
): { width: number; height: number } {
  if (panel === 'settings') return { width: 440, height: 600 }
  if (panel === 'onboarding') return { width: 400, height: 380 }
  if (panel === 'handoff') return { width: 392, height: 196 }
  if (mode === 'collapsed' && docked) return quietIdle ? { width: 44, height: 44 } : { width: 56, height: 56 }

  switch (mode) {
    case 'collapsed':
      return quietIdle ? { width: 116, height: 32 } : { width: 300, height: 52 }
    case 'peek':
    case 'expanded':
      // With 2+ sessions a row per session appears *above* the agent tabs, so
      // the window grows by the list plus the strip it did not replace. Beyond
      // MAX_VISIBLE_SESSION_ROWS the list scrolls instead: an island tall
      // enough for ten sessions stops being an island.
      if (sessionRowCount > 1) {
        const rows = Math.min(sessionRowCount, MAX_VISIBLE_SESSION_ROWS)
        return {
          width: 400,
          height: EXPANDED_BASE_H + rows * SESSION_ROW_H + (rows - 1) * SESSION_ROW_GAP + AGENT_TABS_H
        }
      }
      return { width: 400, height: 172 }
    case 'success':
      return { width: 340, height: 96 }
    case 'error':
      return { width: 372, height: 108 }
    case 'approval':
      // A choice card carries the question, the options, a text field and the
      // terminal link; it is laid out from a different set of parts than the
      // approval card, so it gets its own measure rather than borrowing one.
      if (isChoicePrompt) {
        const rows = Math.min(Math.max(approvalChoiceCount, 2), MAX_VISIBLE_CHOICE_ROWS)
        return { width: 440, height: CHOICE_BASE_H + rows * CHOICE_ROW_H }
      }
      {
        const rows = Math.min(Math.max(approvalChoiceCount, 2), MAX_VISIBLE_APPROVAL_ROWS)
        return {
          width: 440,
          height: APPROVAL_CHROME_H + commandDetailHeight + rows * APPROVAL_ROW_H
        }
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
    options: prompt.options,
    choiceOptions: prompt.choiceOptions,
    isPermission: prompt.kind !== 'choice',
    fingerprint: prompt.fingerprint,
    choices: prompt.choices,
    sessionId: session.id,
    terminalLabel: session.terminalLabel
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
  // The ref is read from listener closures that must not re-subscribe; the
  // state is what lets the panel actually render one row per live session.
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([])

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
  const sessionRows = useMemo(
    () => buildSessionRows(sessions, Object.values(state.approvals)),
    [sessions, state.approvals]
  )
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
    () =>
      sizeForPresentation(
        state.mode,
        docked,
        // Both card kinds are measured by the agent's own option count now;
        // the classified decisions are only a fallback for requests that
        // carried no option list.
        approval?.options?.length ?? approval?.choices?.length ?? 2,
        panel,
        quietIdle,
        sessionRows.length,
        approval?.isPermission === false,
        commandHeight(approval?.detail ?? '')
      ),
    [
      state.mode,
      docked,
      approval?.choices?.length,
      approval?.options?.length,
      approval?.isPermission,
      approval?.detail,
      panel,
      quietIdle,
      sessionRows.length
    ]
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
      /*
       * One live prompt per session, always.
       *
       * A wrapper keeps a single prompt file per session, so a new request
       * from a session means the previous one is gone — whatever order the
       * watcher happened to emit its events in. Enforcing that here stops
       * stale copies of the same panel stacking up in the queue, where only
       * the newest could actually be answered and the rest were dead cards
       * the user had to click through first.
       */
      if (request.sessionId) {
        for (const requestId of stateRef.current.approvalQueue) {
          const queued = stateRef.current.approvals[requestId]
          if (!queued || queued.id === request.id) continue
          if (queued.sessionId !== request.sessionId) continue
          dispatch({
            type: 'INVALIDATE_APPROVAL',
            requestId,
            message: 'That request was replaced by a newer one.',
            kind: 'cancelled'
          })
        }
      }
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
      setSessions(sessions)
      for (const id of AGENT_ORDER) {
        const live = sessions.filter((s) => s.agentId === id)
        const agent = stateRef.current.agents[id]
        if (!agent.available) continue
        if (agent.pendingApprovalIds.length > 0) continue
        // "Working" comes from the wrapper actually seeing output, never from
        // a session merely existing — that is what left the pill insisting an
        // agent was running long after it had finished.
        const working = live.some((session) => session.busy)
        dispatch({
          type: 'SET_AGENT_STATUS',
          agentId: id,
          status: working ? 'running' : 'idle',
          activityLabel: !live.length
            ? 'No session running'
            : live.length > 1
              ? `${live.length} sessions open`
              : working
                ? `Working in ${live[0].terminalLabel}`
                : `Session open in ${live[0].terminalLabel}`,
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
      //
      // Match on sessionId, not on the prompt id. Prompt ids are minted as
      // `claude-<ts>-<rand>` and never carried the session id as a prefix, so
      // the old `startsWith` test could not match: closing a terminal left the
      // island insisting that agent still needed input, and because the
      // handoff panel has no settings button, that stuck panel also cut off
      // the only route to settings.
      setTerminalInput((current) => (current?.sessionId === session.id ? null : current))
      setPanel((current) => (current === 'handoff' ? null : current))
      // Queued approvals from a dead session can never be answered either.
      for (const requestId of stateRef.current.approvalQueue) {
        if (stateRef.current.approvals[requestId]?.sessionId !== session.id) continue
        dispatch({
          type: 'INVALIDATE_APPROVAL',
          requestId,
          message: 'That terminal closed before this was answered.',
          kind: 'cancelled'
        })
      }
      refreshSessions()
    })

    const offSessionPrompt = api.onSessionPrompt(({ prompt, session, terminalFocused }) => {
      // The user is already in the terminal that asked. Track the prompt so the
      // pill reflects it, but do not open over the thing they are reading.
      // A choice rides the same queue as an approval: both are things the
      // island can answer, both must be shown one at a time and in the order
      // the agents asked. Only the card differs.
      if (prompt.kind === 'approval' || prompt.kind === 'choice') {
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
      if (prompt.kind === 'approval' || prompt.kind === 'choice') {
        /*
         * A prompt disappearing looks the same however it ended, so the
         * wrapper records the one the user answered itself. Without that, the
         * island told people their own answer had been closed or had expired —
         * wrong, and alarming enough to make them answer twice.
         */
        const answeredHere = sessionsRef.current.some(
          (session) => session.answeredLocallyPromptId === prompt.promptId
        )
        dispatch({
          type: 'INVALIDATE_APPROVAL',
          requestId: prompt.promptId,
          message: answeredHere
            ? 'You answered this in the terminal.'
            : 'The agent moved on before this was answered.',
          kind: answeredHere ? 'answered-elsewhere' : 'cancelled'
        })
        return
      }
      setTerminalInput((current) => (current?.id === prompt.promptId ? null : current))
      setPanel((current) => (current === 'handoff' ? null : current))
      refreshSessions()
    })

    refreshSessions()
    // Transient labels (a just-answered approval, a cleared prompt) otherwise
    // stick until a session is added or removed, which may never happen.
    const statusTimer = window.setInterval(refreshSessions, 3000)
    void api.listSessionPrompts().then((list) => {
      if (disposed || !Array.isArray(list)) return
      for (const prompt of list) {
        const session = sessionsRef.current.find((item: AgentSessionRecord) => item.id === prompt.sessionId)
        if (!session) continue
        if (prompt.kind === 'approval' || prompt.kind === 'choice') {
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
      window.clearInterval(statusTimer)
      offSessionAdded()
      offSessionRemoved()
      offSessionPrompt()
      offSessionPromptCleared()
      for (const timer of Object.values(completionTimers.current)) {
        if (timer) window.clearTimeout(timer)
      }
    }
  }, [])

  /*
   * Every window size in this app is arithmetic over hand-kept constants that
   * have to track the CSS. Twice in one session that arithmetic was wrong: once
   * reserving space for chrome that had been deleted, once under-reserving so
   * the options were pushed into a scroll. The constants are a reasonable first
   * guess and a poor source of truth.
   *
   * So the guess is measured against the render. If the content still does not
   * fit, the window grows by the shortfall. Only ever grows, so it cannot
   * oscillate; capped, so a runaway measurement cannot fill the screen; and
   * reset whenever the intended size changes, so it re-measures per card rather
   * than accumulating.
   */
  /**
   * Corner radius, tracked from the viewport rather than from `size`.
   *
   * `size` is the *target*; the window travels there over up to ~380ms driven
   * by the spring in the main process. Reading the viewport instead means the
   * radius is whatever the current shape actually needs on every frame, so the
   * corner flows with the morph instead of popping when a class changes.
   */
  const [surfaceRadius, setSurfaceRadius] = useState(() =>
    radiusForSize(window.innerWidth, window.innerHeight)
  )
  useEffect(() => {
    let frame = 0
    const measure = () => {
      frame = 0
      setSurfaceRadius(radiusForSize(window.innerWidth, window.innerHeight))
    }
    const onResize = () => {
      // Coalesce to one read per frame: the main process pushes bounds at the
      // panel's refresh rate, and a synchronous read per event would thrash.
      if (frame === 0) frame = window.requestAnimationFrame(measure)
    }
    window.addEventListener('resize', onResize)
    measure()
    return () => {
      window.removeEventListener('resize', onResize)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [])

  const [overflowPad, setOverflowPad] = useState(0)
  useEffect(() => setOverflowPad(0), [size.width, size.height])

  useEffect(() => {
    if (!settingsLoaded) return
    /*
     * Only once the window has stopped moving.
     *
     * The resize is a spring animation in the main process, so for a couple of
     * hundred milliseconds the window is smaller than it is going to be.
     * Measuring during that reads a shortfall that is about to close on its
     * own, and the correction then adds height nothing needed — visible as a
     * band of empty space below the last option.
     */
    if (isMorphing) return
    const timer = window.setTimeout(() => {
      const scroller = document.querySelector('.approval-card, .choice-card')
      if (!(scroller instanceof HTMLElement)) return
      const shortfall = scroller.scrollHeight - scroller.clientHeight
      if (shortfall > OVERFLOW_EPSILON) {
        setOverflowPad((pad) => Math.min(pad + shortfall, MAX_OVERFLOW_PAD))
      }
    }, 120)
    return () => window.clearTimeout(timer)
  }, [size.width, size.height, overflowPad, settingsLoaded, isMorphing])

  useEffect(() => {
    if (!settingsLoaded) return
    const api = window.agentIsland
    if (!api) return
    const run = ++resizeRunRef.current
    setIsMorphing(true)
    // A rejected resize must still release the morph lock, otherwise every
    // control in the island stays permanently inert behind `is-morphing`.
    void api
      .resize(size.width, size.height + overflowPad)
      .catch((error: unknown) => {
        console.error('Island resize failed:', error)
      })
      .finally(() => {
        if (resizeRunRef.current === run) setIsMorphing(false)
      })
  }, [size.width, size.height, overflowPad, settingsLoaded])

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
  const hasAttention = queueCount > 0 || terminalInput !== null
  useEffect(() => {
    if (!isExpandedPresentation) return
    if (windowFocused || state.hovered || isDragging) return
    // A prompt opens without taking focus, so it has to stay long enough to
    // read and reach with the mouse; an island that merely drifted open should
    // get out of the way immediately. Either way the pill keeps carrying the
    // attention state, so nothing is lost by retracting.
    const delay = hasAttention ? 6000 : 1000
    const timer = window.setTimeout(() => {
      if (dragRef.current?.active) return
      setPanel(null)
      dispatch({ type: 'COLLAPSE' })
    }, delay)
    return () => window.clearTimeout(timer)
  }, [isExpandedPresentation, windowFocused, state.hovered, isDragging, hasAttention])

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

  /**
   * Handoff prompts had no liveness check at all — only the `prompt-cleared`
   * and `session-removed` events retired them, so a single missed event left
   * "needs input" on screen forever with no way to clear it.
   *
   * This sweep is the backstop: a prompt is dropped once it expires, or as
   * soon as the session that raised it is no longer in the registry.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      setTerminalInput((current) => {
        if (!current) return current
        if (Date.now() > current.expiresAt) return null
        if (current.sessionId && !sessionsRef.current.some((s) => s.id === current.sessionId)) return null
        return current
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (terminalInput) return
    setPanel((current) => (current === 'handoff' ? null : current))
  }, [terminalInput])

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

  /**
   * Answer a numbered question, either by picking an option or by typing.
   *
   * Deliberately separate from `onDecision`: that path is gated by
   * `canApproveRequest`, whose invariants (risk known, permission semantics)
   * describe a permission grant. A question is not one, and running it through
   * those checks would block perfectly ordinary answers for being "unknown
   * risk".
   */
  const answerChoice = async (answer: { optionIndex?: number; text?: string }) => {
    if (!approval?.sessionId || isMorphing) return
    const api = window.agentIsland
    const result = await api.answerSessionPrompt({
      sessionId: approval.sessionId,
      promptId: approval.id,
      ...answer
    })
    if (!result.ok) {
      dispatch({ type: 'SET_ERROR', message: result.error ?? 'The agent no longer accepts this answer.' })
      return
    }
    // 'once' is the state machine's neutral "answered and dismissed"; it is not
    // shown to the user for a choice prompt.
    dispatch({ type: 'ANSWER_APPROVAL', requestId: approval.id, decision: 'once' })
  }

  /**
   * Answer an approval by the agent's own digit.
   *
   * Separate from `answerChoice` because an approval still has to clear
   * `canApproveRequest` — a permission grant on a stale or dead request must
   * not go through, and denying must stay possible when approving does not.
   * The classification is passed only so the transient message and the guard
   * describe the right thing; the digit is what gets sent.
   */
  const answerApprovalOption = async (index: number, decision: ApprovalDecision | null) => {
    if (!approval || isMorphing) return
    const isDeny = decision === 'deny'
    if (!isDeny && !approveEnabled) return
    const api = window.agentIsland
    if (approval.sessionId) {
      const result = await api.answerSessionPrompt({
        sessionId: approval.sessionId,
        promptId: approval.id,
        optionIndex: index,
        /*
         * Sent alongside the digit purely for compatibility. A wrapper older
         * than the optionIndex protocol reads only `choice`; without this it
         * resolves no keystroke, and the approval appears to do nothing in the
         * terminal. Both fields are derived from the same detection, so they
         * cannot disagree — a newer wrapper prefers the digit and ignores this.
         */
        ...(decision ? { decision } : {})
      })
      if (!result.ok) {
        dispatch({ type: 'SET_ERROR', message: result.error ?? 'The agent no longer accepts this decision.' })
        return
      }
    }
    // An unclassified option is still an answer; 'once' is the machine's
    // neutral "answered and dismissed" and never claims a broader grant.
    dispatch({ type: 'ANSWER_APPROVAL', requestId: approval.id, decision: decision ?? 'once' })
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
    void window.agentIsland.installShims()
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
      style={{ ['--surface-radius' as string]: `${surfaceRadius}px` }}
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
          sessionRows={sessionRows}
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
          onChoiceOption={(index) => void answerChoice({ optionIndex: index })}
          onChoiceText={(text) => void answerChoice({ text })}
          onApprovalOption={(index, decision) => void answerApprovalOption(index, decision)}
          onContinueInTerminal={(agentId, sessionId) => void openTerminal(agentId, sessionId)}
          onOpenTerminal={(agentId, sessionId) => void openTerminal(agentId, sessionId)}
          onShowApproval={(sessionId) => {
            // The oldest queued request for that session — the one it is
            // actually blocked on.
            const requestId = stateRef.current.approvalQueue.find(
              (id) => stateRef.current.approvals[id]?.sessionId === sessionId
            )
            if (requestId) dispatch({ type: 'SHOW_APPROVAL', requestId })
          }}
          onDismissHandoff={() => {
            setTerminalInput(null)
            setPanel(null)
            dispatch({ type: 'COLLAPSE' })
          }}
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
