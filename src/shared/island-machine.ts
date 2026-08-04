import {
  AGENT_ORDER,
  type AgentId,
  type AgentSnapshot,
  type AgentStatus,
  type ApprovalRequest,
  type IslandMode,
  type IslandSnapshot,
  createDefaultAgents
} from './contracts'
import { canApproveRequest } from './approval-guard'

export type IslandEvent =
  | { type: 'HOVER_ENTER' }
  | { type: 'HOVER_LEAVE' }
  | { type: 'FOCUS' }
  | { type: 'BLUR' }
  | { type: 'CLICK_PILL' }
  | { type: 'SELECT_AGENT'; agentId: AgentId }
  | { type: 'EXPAND' }
  | { type: 'COLLAPSE' }
  | { type: 'SET_AGENT_STATUS'; agentId: AgentId; status: AgentStatus; activityLabel?: string; lastError?: string }
  | { type: 'ENQUEUE_APPROVAL'; request: ApprovalRequest }
  | { type: 'ANSWER_APPROVAL'; requestId: string; decision: 'approve' | 'deny' }
  | { type: 'COMPLETE'; message?: string }
  | { type: 'DISMISS_TRANSIENT' }
  | { type: 'SET_ERROR'; message: string }

export function createInitialIslandState(cwd = ''): IslandSnapshot {
  return {
    mode: 'collapsed',
    activeAgentId: 'hermes',
    agents: createDefaultAgents(cwd),
    approvals: {},
    approvalQueue: [],
    hovered: false,
    focused: false
  }
}

function nextModeAfterInteraction(state: IslandSnapshot): IslandMode {
  if (state.approvalQueue.length > 0) return 'approval'
  if (state.mode === 'expanded') return 'expanded'
  if (state.hovered || state.focused) return 'peek'
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

export function reduceIsland(state: IslandSnapshot, event: IslandEvent): IslandSnapshot {
  switch (event.type) {
    case 'HOVER_ENTER': {
      const next = { ...state, hovered: true }
      return { ...next, mode: nextModeAfterInteraction(next) }
    }
    case 'HOVER_LEAVE': {
      const next = { ...state, hovered: false }
      return { ...next, mode: nextModeAfterInteraction(next) }
    }
    case 'FOCUS': {
      const next = { ...state, focused: true }
      return { ...next, mode: nextModeAfterInteraction(next) }
    }
    case 'BLUR': {
      const next = { ...state, focused: false }
      return { ...next, mode: nextModeAfterInteraction(next) }
    }
    case 'CLICK_PILL': {
      if (state.mode === 'collapsed') {
        return { ...state, mode: state.approvalQueue.length ? 'approval' : 'peek', focused: true }
      }
      if (state.mode === 'peek') {
        return { ...state, mode: 'collapsed', focused: false }
      }
      return state
    }
    case 'SELECT_AGENT': {
      if (!AGENT_ORDER.includes(event.agentId)) return state
      return {
        ...state,
        activeAgentId: event.agentId,
        mode: state.mode === 'collapsed' ? 'peek' : state.mode
      }
    }
    case 'EXPAND':
      return { ...state, mode: state.approvalQueue.length ? 'approval' : 'expanded', focused: true }
    case 'COLLAPSE':
      return {
        ...state,
        mode: state.approvalQueue.length ? 'approval' : 'collapsed',
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
          available: event.status !== 'offline'
        })
      }
    }
    case 'ENQUEUE_APPROVAL': {
      const request = event.request
      const agent = state.agents[request.agentId]
      if (!agent) return state

      const approvals = { ...state.approvals, [request.id]: request }
      const approvalQueue = state.approvalQueue.includes(request.id)
        ? state.approvalQueue
        : [...state.approvalQueue, request.id]

      return {
        ...state,
        approvals,
        approvalQueue,
        activeAgentId: request.agentId,
        mode: 'approval',
        agents: withAgent(state.agents, request.agentId, {
          status: 'waiting',
          activityLabel: 'Needs approval',
          pendingApprovalIds: [...new Set([...agent.pendingApprovalIds, request.id])]
        })
      }
    }
    case 'ANSWER_APPROVAL': {
      const request = state.approvals[event.requestId]
      const guard = canApproveRequest({
        request,
        displayedRequestId: event.requestId
      })

      // Deny is always allowed for a known pending request so users can reject stale UI safely.
      const canAct =
        event.decision === 'deny'
          ? Boolean(request && !request.answered)
          : guard.canApprove

      if (!request || !canAct) {
        return {
          ...state,
          mode: 'error',
          message: guard.reason ?? 'Cannot answer this request from the island'
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

      const next: IslandSnapshot = {
        ...state,
        approvals,
        approvalQueue,
        agents: withAgent(state.agents, request.agentId, {
          pendingApprovalIds,
          status: pendingApprovalIds.length ? 'waiting' : 'running',
          activityLabel:
            event.decision === 'approve'
              ? 'Approved — continuing'
              : 'Denied — waiting for next step'
        }),
        mode: approvalQueue.length
          ? 'approval'
          : event.decision === 'approve'
            ? 'success'
            : 'peek',
        message:
          event.decision === 'approve'
            ? `Approved ${request.summary}`
            : `Denied ${request.summary}`,
        activeAgentId: request.agentId
      }

      return next
    }
    case 'COMPLETE': {
      if (state.hovered || state.focused || state.approvalQueue.length > 0) {
        return {
          ...state,
          mode: state.approvalQueue.length ? 'approval' : state.mode === 'expanded' ? 'expanded' : 'peek',
          message: event.message
        }
      }
      return {
        ...state,
        mode: 'success',
        message: event.message ?? 'Done'
      }
    }
    case 'DISMISS_TRANSIENT': {
      if (state.mode !== 'success' && state.mode !== 'error') return state
      const next = { ...state, message: undefined }
      return { ...next, mode: nextModeAfterInteraction(next) }
    }
    case 'SET_ERROR':
      return {
        ...state,
        mode: 'error',
        message: event.message
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
