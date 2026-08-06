/**
 * The contract between a live agent session and Agent Island.
 *
 * Agent Island does not launch agents and does not own their terminals. A thin
 * wrapper (`island <agent>`) runs *inside* the user's real terminal, resolves
 * which OS window is hosting it, and publishes that here. The island reads
 * these files, shows prompts, and — on handoff — raises the recorded window.
 *
 * Layout under %LOCALAPPDATA%/agent-island:
 *   sessions/<id>.json    wrapper writes: identity + host window + heartbeat
 *   prompts/<id>.json     wrapper writes: the prompt currently on screen
 *   decisions/<id>.json   island writes:  the answer to a prompt
 *
 * Files, not sockets, deliberately: it is the mechanism the Hermes bridge
 * already proved on this machine, it survives either side restarting, and it
 * needs no port, permission or handshake.
 */

export type TerminalKind =
  | 'windows-terminal'
  | 'conhost'
  | 'mintty'
  | 'vscode'
  | 'unknown'

export interface AgentSessionRecord {
  /** Stable id for this session; also the prompt/decision file name. */
  id: string
  agentId: 'claude' | 'codex' | 'hermes'
  /** Win32 pid of the wrapper. On MSYS this must NOT be `$$`. */
  pid: number
  /**
   * Host terminal window, as a decimal HWND. Null when the handshake could not
   * resolve one (VS Code panels, unknown emulators) — the island must then say
   * so rather than raising the wrong window.
   */
  hwnd: number | null
  terminalKind: TerminalKind
  /** Best-effort human label for disambiguation in the UI. */
  terminalLabel: string
  cwd: string
  startedAt: number
  /** Refreshed while the session lives; used to reap crashed wrappers. */
  heartbeatAt: number
}

/** A prompt the wrapper detected but the island must not answer for the user. */
export interface SessionPromptRecord {
  sessionId: string
  agentId: 'claude' | 'codex' | 'hermes'
  /** 'approval' is answerable in the island; 'handoff' needs the terminal. */
  kind: 'approval' | 'handoff'
  promptId: string
  title: string
  detail: string
  cwd: string
  createdAt: number
  expiresAt: number
  fingerprint: string
  /** Only meaningful for kind === 'approval'. */
  choices?: Array<'once' | 'session' | 'always' | 'deny'>
  risk?: 'low' | 'elevated' | 'high' | 'unknown'
  riskReason?: string
}

export interface SessionDecisionRecord {
  sessionId: string
  promptId: string
  choice: 'once' | 'session' | 'always' | 'deny'
  decidedAt: number
}

/** A wrapper that has not checked in for this long is treated as dead. */
export const SESSION_STALE_MS = 20_000
/** How often a live wrapper refreshes `heartbeatAt`. */
export const SESSION_HEARTBEAT_MS = 5_000

export function isTerminalKind(value: unknown): value is TerminalKind {
  return (
    value === 'windows-terminal' ||
    value === 'conhost' ||
    value === 'mintty' ||
    value === 'vscode' ||
    value === 'unknown'
  )
}

function isAgent(value: unknown): value is AgentSessionRecord['agentId'] {
  return value === 'claude' || value === 'codex' || value === 'hermes'
}

/** U+FEFF, which `JSON.parse` rejects. Windows editors emit it freely. */
export function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
}

export function parseSessionRecord(raw: string): AgentSessionRecord | null {
  try {
    const value = JSON.parse(stripBom(raw)) as Partial<AgentSessionRecord>
    if (typeof value.id !== 'string' || !value.id) return null
    if (!isAgent(value.agentId)) return null
    if (typeof value.pid !== 'number' || !Number.isFinite(value.pid)) return null
    const hwnd =
      typeof value.hwnd === 'number' && Number.isFinite(value.hwnd) && value.hwnd > 0
        ? value.hwnd
        : null
    return {
      id: value.id,
      agentId: value.agentId,
      pid: Math.trunc(value.pid),
      hwnd,
      terminalKind: isTerminalKind(value.terminalKind) ? value.terminalKind : 'unknown',
      terminalLabel: typeof value.terminalLabel === 'string' ? value.terminalLabel : 'Terminal',
      cwd: typeof value.cwd === 'string' ? value.cwd : '',
      startedAt: typeof value.startedAt === 'number' ? value.startedAt : Date.now(),
      heartbeatAt: typeof value.heartbeatAt === 'number' ? value.heartbeatAt : 0
    }
  } catch {
    return null
  }
}

export function parsePromptRecord(raw: string): SessionPromptRecord | null {
  try {
    const value = JSON.parse(stripBom(raw)) as Partial<SessionPromptRecord>
    if (typeof value.sessionId !== 'string' || !value.sessionId) return null
    if (typeof value.promptId !== 'string' || !value.promptId) return null
    if (!isAgent(value.agentId)) return null
    if (value.kind !== 'approval' && value.kind !== 'handoff') return null
    return {
      sessionId: value.sessionId,
      agentId: value.agentId,
      kind: value.kind,
      promptId: value.promptId,
      title: typeof value.title === 'string' ? value.title : 'Needs input',
      detail: typeof value.detail === 'string' ? value.detail : '',
      cwd: typeof value.cwd === 'string' ? value.cwd : '',
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
      expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : Date.now() + 300_000,
      fingerprint: typeof value.fingerprint === 'string' ? value.fingerprint : '',
      choices: Array.isArray(value.choices) ? value.choices : undefined,
      risk: value.risk,
      riskReason: typeof value.riskReason === 'string' ? value.riskReason : undefined
    }
  } catch {
    return null
  }
}

export function isSessionStale(record: AgentSessionRecord, now = Date.now()): boolean {
  return now - record.heartbeatAt > SESSION_STALE_MS
}
