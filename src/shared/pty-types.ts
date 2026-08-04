import type { AgentId } from './contracts'

export interface PtyStartRequest {
  agentId: AgentId
  cols: number
  rows: number
  cwd?: string
}

export interface PtyWriteRequest {
  agentId: AgentId
  data: string
}

export interface PtyResizeRequest {
  agentId: AgentId
  cols: number
  rows: number
}

export interface PtyStopRequest {
  agentId: AgentId
  force?: boolean
}

export interface PtySessionInfo {
  agentId: AgentId
  alive: boolean
  pid?: number
  cwd: string
  cols: number
  rows: number
  command: string
  startedAt?: number
  lastError?: string
}

export interface PtyDataEvent {
  agentId: AgentId
  data: string
}

export interface PtyExitEvent {
  agentId: AgentId
  exitCode: number
  signal?: number
}

export interface PtyStartResult {
  ok: boolean
  session?: PtySessionInfo
  error?: string
  replay?: string
}

export function isAgentId(value: unknown): value is AgentId {
  return value === 'claude' || value === 'codex' || value === 'hermes'
}

export function validateSize(cols: number, rows: number): string | null {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return 'cols/rows must be numbers'
  if (cols < 20 || cols > 400) return 'cols out of range'
  if (rows < 5 || rows > 120) return 'rows out of range'
  return null
}

/** Cap IPC payload size so a runaway PTY can't flood the renderer. */
export const MAX_PTY_WRITE_CHARS = 16_384
export const MAX_REPLAY_CHARS = 80_000
