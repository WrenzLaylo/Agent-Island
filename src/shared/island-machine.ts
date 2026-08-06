import {
  AGENT_ORDER,
  type AgentId,
  type ApprovalDecision,
  type AgentSnapshot,
  type AgentStatus,
  type ApprovalRequest,
  type IslandMode,
  type IslandSnapshot,
  type TransientKind,
  createDefaultAgents
} from './contracts'
import { canApproveRequest } from './approval-guard'

export type IslandEvent =
  | { type: 'HOVER_ENTER' }
  | { type: 'HOVER_LEAVE' }
  | { type: 'HOVER_OPEN' }
  | { type: 'FOCUS' }
  | { type: 'BLUR' }
  | { type: 'CLICK_PILL' }
  | { type: 'SELECT_AGENT'; agentId: AgentId; open?: boolean }
  | { type: 'EXPAND' }
  | { type: 'COLLAPSE' }
  | {
      type: 'SET_AGENT_STATUS'
      agentId: AgentId
      status: AgentStatus
      activityLabel?: string
      lastError?: string
      available?: boolean
      integrationMode?: import('./contracts').IntegrationMode
      version?: string
    }
  | { type: 'ENQUEUE_APPROVAL'; request: ApprovalRequest; autoExpand?: boolean }
  | { type: 'ANSWER_APPROVAL'; requestId: string; decision: ApprovalDecision }
  | {
      type: 'INVALIDATE_APPROVAL'
      requestId: string
      message?: string
      kind?: Extract<TransientKind, 'expired' | 'cancelled' | 'error'>
    }
  | { type: 'COMPLETE'; message?: string }
  | { type: 'DISMISS_TRANSIENT' }
  | { type: 'SET_ERROR'; message: string }

export function createInitialIslandState(cwd = '', activeAgentId: AgentId = 'hermes'): IslandSnapshot {
  return {
    mode: 'collapsed',
    activeAgentId,
    agents: createDefaultAgents(cwd),
    approvals: {},
    approvalQueue: [],
    hovered: false,
    focused: false
  }
}

function nextModeAfterInteraction(state: IslandSnapshot): IslandMode {
  if (state.mode === 'approval' || state.mode === 'expanded') return state.mode
  if (state.mode === 'peek' && (state.hovered || state.focused)) return 'peek'
  if (state.mode === 'success' || state.mode === 'error') return state.mode
  return 'collapsed'
}

function withAgent(
  agents: Record<AgentId, AgentSnapshot>,
  agentId: AgentId,
  patch: Partial<AgentSnapshot>
): Record<AgentId, AgentSnapshot> {
  return {
    ...agents,
    [agentId]: {
      ...agents[agentId],
      ...patch
    }
  }
}

function decisionMessage(decision: ApprovalDecision, summary: string): string {
  switch (decision) {
    case 'session':
      return `Allowed for this session: ${summary}`
    case 'always':
      return `Added to permanent allowlist: ${summary}`
    case 'deny':
      return `Denied: ${summary}`
    default:
      return `Allowed once: ${summary}`
  }
}

function removePendingRequest(
  state: IslandSnapshot,
  request: ApprovalRequest
): Pick<IslandSnapshot, 'approvals' | 'approvalQueue' | 'agents'> {
  const approvals = {
    ...state.approvals,
    [request.id]: {
      ...request,
      waitingForInput: false,
      superseded: true
    }
  }
  const approvalQueue = state.approvalQueue.filter((id) => id !== request.id)
  const agent = state.agents[request.agentId]
  const pendingApprovalIds = agent.pendingApprovalIds.filter((id) => id !== request.id)
  const agents = withAgent(state.agents, request.agentId, {
    pendingApprovalIds,
    status: pendingApprovalIds.length ? 'waiting' : agent.available ? 'idle' : 'offline',
    activityLabel: pendingApprovalIds.length ? 'Needs approval' : agent.available ? 'Ready' : 'Not connected'
  })
  return { approvals, approvalQueue, agents }
}

export function reduceIsland(state: IslandSnapshot, event: IslandEvent): IslandSnapshot {
  switch (event.type) {
    case 'HOVER_ENTER':
      return { ...state, hovered: true }

    case 'HOVER_LEAVE': {
      const next = { ...state, hovered: false }
      if (state.mode === 'peek' && !state.focused) return { ...next, mode: 'collapsed' }
      return next
    }

    case 'HOVER_OPEN':
      if (!state.hovered || state.mode !== 'collapsed') return state
      return {
        ...state,
        mode: state.approvalQueue.length ? 'approval' : 'peek'
      }

    case 'FOCUS': {
      const next = { ...state, focused: true }
      return { ...next, mode: nextModeAfterInteraction(next) }
    }

    case 'BLUR': {
      const next = { ...state, focused: false }
      return { ...next, mode: nextModeAfterInteraction(next) }
    }

    case 'CLICK_PILL':
      if (state.mode === 'collapsed') {
        return {
          ...state,
          mode: state.approvalQueue.length ? 'approval' : 'peek',
          focused: true
        }
      }
      if (state.mode === 'peek') {
        return { ...state, mode: 'collapsed', focused: false, hovered: false }
      }
      return state

    case 'SELECT_AGENT':
      if (!AGENT_ORDER.includes(event.agentId)) return state
      return {
        ...state,
        activeAgentId: event.agentId,
        mode: event.open === false ? state.mode : state.mode === 'collapsed' ? 'peek' : state.mode
      }

    case 'EXPAND':
      return {
        ...state,
        mode: state.approvalQueue.length ? 'approval' : 'peek',
        focused: true
      }

    case 'COLLAPSE':
      return {
        ...state,
        mode: 'collapsed',
        focused: false,
        hovered: false
      }

    case 'SET_AGENT_STATUS': {
      const agent = state.agents[event.agentId]
      if (!agent) return state
      return {
        ...state,
        agents: withAgent(state.agents, event.agentId, {
          status: event.status,
          activityLabel: event.activityLabel ?? agent.activityLabel,
          lastError: event.lastError,
          available: event.available ?? event.status !== 'offline',
          integrationMode: event.integrationMode ?? agent.integrationMode,
          version: event.version ?? agent.version
        })
      }
    }

    case 'ENQUEUE_APPROVAL': {
      const request = event.request
      const agent = state.agents[request.agentId]
      if (!agent) return state

      const approvals = { ...state.approvals, [request.id]: request }
      // Ordered by when the agent actually asked, not by when this process
      // happened to notice. Requests arrive from a directory listing and in a
      // startup batch, so arrival order is filesystem order — which made the
      // header claim "oldest" about whichever file was read first.
      const approvalQueue = state.approvalQueue.includes(request.id)
        ? state.approvalQueue
        : [...state.approvalQueue, request.id].sort(
            (left, right) => (approvals[left]?.createdAt ?? 0) - (approvals[right]?.createdAt ?? 0)
          )
      const autoExpand = event.autoExpand !== false

      return {
        ...state,
        approvals,
        approvalQueue,
        // Follow the request being shown, which is the head of the queue — not
        // the one that just arrived, which may be queued behind it.
        activeAgentId: approvals[approvalQueue[0]]?.agentId ?? request.agentId,
        mode: autoExpand ? 'approval' : state.mode,
        transientKind: undefined,
        message: undefined,
        agents: withAgent(state.agents, request.agentId, {
          available: true,
          status: 'waiting',
          activityLabel: 'Needs approval',
          pendingApprovalIds: [...new Set([...agent.pendingApprovalIds, request.id])]
        })
      }
    }

    case 'ANSWER_APPROVAL': {
      const request = state.approvals[event.requestId]
      const guard = canApproveRequest({ request, displayedRequestId: event.requestId })
      const allowedChoice = !request?.choices?.length || request.choices.includes(event.decision)
      const canAct =
        event.decision === 'deny'
          ? Boolean(request && !request.answered && allowedChoice)
          : guard.canApprove && allowedChoice

      if (!request || !canAct) {
        return {
          ...state,
          mode: 'error',
          transientKind: 'error',
          message: !allowedChoice
            ? 'That permission option is not available for this request'
            : guard.reason ?? 'Cannot answer this request from the island'
        }
      }

      const answered: ApprovalRequest = {
        ...request,
        answered: true,
        waitingForInput: false
      }
      const approvals = { ...state.approvals, [request.id]: answered }
      const approvalQueue = state.approvalQueue.filter((id) => id !== request.id)
      const agent = state.agents[request.agentId]
      const pendingApprovalIds = agent.pendingApprovalIds.filter((id) => id !== request.id)

      return {
        ...state,
        approvals,
        approvalQueue,
        agents: withAgent(state.agents, request.agentId, {
          pendingApprovalIds,
          // The decision is acknowledged by the transient card and `message`.
          // Writing it into the agent's status made a momentary confirmation
          // ("Allowed once") the agent's permanent state, so the island still
          // claimed the agent was working long after the turn had finished.
          status: pendingApprovalIds.length ? 'waiting' : agent.available ? 'idle' : 'offline',
          activityLabel: pendingApprovalIds.length ? 'Needs approval' : 'Ready'
        }),
        mode: approvalQueue.length ? 'approval' : 'success',
        message: decisionMessage(event.decision, request.summary),
        transientKind: event.decision === 'deny' ? 'denied' : 'approved',
        activeAgentId: approvalQueue.length
          ? state.approvals[approvalQueue[0]]?.agentId ?? request.agentId
          : request.agentId,
        focused: approvalQueue.length > 0,
        hovered: false
      }
    }

    case 'INVALIDATE_APPROVAL': {
      const request = state.approvals[event.requestId]
      if (!request || request.answered) return state
      const removed = removePendingRequest(state, request)
      const kind = event.kind ?? (Date.now() > request.expiresAt ? 'expired' : 'cancelled')
      const fallback = kind === 'expired' ? 'Approval request expired' : 'Approval request closed'
      return {
        ...state,
        ...removed,
        activeAgentId: removed.approvalQueue.length
          ? state.approvals[removed.approvalQueue[0]]?.agentId ?? state.activeAgentId
          : state.activeAgentId,
        mode: removed.approvalQueue.length ? 'approval' : 'error',
        message: event.message ?? fallback,
        transientKind: kind,
        focused: removed.approvalQueue.length > 0,
        hovered: false
      }
    }

    case 'COMPLETE':
      if (state.approvalQueue.length > 0) return { ...state, mode: 'approval' }
      return {
        ...state,
        mode: state.hovered || state.focused ? 'peek' : 'success',
        message: event.message ?? 'Completed',
        transientKind: 'completed'
      }

    case 'DISMISS_TRANSIENT':
      if (state.mode !== 'success' && state.mode !== 'error') return state
      return {
        ...state,
        mode: state.approvalQueue.length ? 'approval' : 'collapsed',
        message: undefined,
        transientKind: undefined,
        focused: false,
        hovered: false
      }

    case 'SET_ERROR':
      return {
        ...state,
        mode: 'error',
        transientKind: 'error',
        message: event.message,
        focused: false,
        hovered: false
      }

    default:
      return state
  }
}

export function currentApproval(state: IslandSnapshot): ApprovalRequest | undefined {
  const id = state.approvalQueue[0]
  return id ? state.approvals[id] : undefined
}

export function pendingApprovalCount(state: IslandSnapshot): number {
  return state.approvalQueue.length
}
