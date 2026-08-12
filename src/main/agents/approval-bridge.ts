/**
 * File bridge between Agent Island and live Hermes sessions.
 *
 * Layout under %LOCALAPPDATA%/hermes/agent-island/bridge:
 *   pending/<id>.json     — Hermes plugin writes when approval is needed
 *   decisions/<id>.json   — Island writes once|session|always|deny
 *   heartbeat.json        — Island heartbeat so Hermes knows HUD is alive
 */
import { mkdir, readdir, readFile, writeFile, unlink, rename } from 'node:fs/promises'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { EventEmitter } from 'node:events'
import type { ApprovalDecision, ApprovalRequest, RiskLevel } from '../../shared/contracts'
import { classifyCommandRisk } from './hermes-approval'

export interface BridgePendingFile {
  id: string
  command: string
  description?: string
  sessionKey?: string
  surface?: string
  cwd?: string
  createdAt: number
  expiresAt?: number
  choices?: ApprovalDecision[]
}

const APPROVAL_DECISIONS: ApprovalDecision[] = ['once', 'session', 'always', 'deny']

/** U+FEFF, which `JSON.parse` rejects. */
export function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
}

function normaliseChoices(choices: BridgePendingFile['choices']): ApprovalDecision[] {
  const filtered = Array.isArray(choices)
    ? choices.filter((choice): choice is ApprovalDecision => APPROVAL_DECISIONS.includes(choice))
    : []

  if (!filtered.includes('once')) filtered.unshift('once')
  if (!filtered.includes('deny')) filtered.push('deny')
  return [...new Set(filtered)]
}

/**
 * Bridge root for Agent Island's own clients — currently the Claude Code hook.
 *
 * Separate from the Hermes plugin's root, which lives under hermes' own
 * directory. Sharing it would put one agent's requests inside another agent's
 * data, and make either uninstall take the other's queue with it.
 */
export function islandBridgeRoot(): string {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(local, 'agent-island', 'bridge')
}

export function bridgeRoot(): string {
  return join(homedir(), 'AppData', 'Local', 'hermes', 'agent-island', 'bridge')
}

export function pendingDir(root = bridgeRoot()): string {
  return join(root, 'pending')
}

export function decisionsDir(root = bridgeRoot()): string {
  return join(root, 'decisions')
}

export async function ensureBridgeDirs(root = bridgeRoot()): Promise<void> {
  await mkdir(pendingDir(root), { recursive: true })
  await mkdir(decisionsDir(root), { recursive: true })
}

export function bridgePendingToApproval(file: BridgePendingFile): ApprovalRequest {
  const risk: RiskLevel = classifyCommandRisk(file.command).level
  const reason = classifyCommandRisk(file.command).reason
  const now = Date.now()
  return {
    id: file.id,
    agentId: 'hermes',
    summary: 'Hermes needs permission',
    detail: file.command,
    cwd: file.cwd || '',
    risk,
    riskReason: file.description || reason,
    createdAt: file.createdAt || now,
    expiresAt: file.expiresAt || now + 5 * 60_000,
    processAlive: true,
    waitingForInput: true,
    answered: false,
    superseded: false,
    source: 'hermes-bridge',
    fingerprint: file.id,
    choices: normaliseChoices(file.choices)
  }
}

export async function writeDecision(
  id: string,
  choice: ApprovalDecision,
  root = bridgeRoot()
): Promise<void> {
  await ensureBridgeDirs(root)
  const target = join(decisionsDir(root), `${id}.json`)
  const tmp = `${target}.tmp`
  const payload = JSON.stringify(
    {
      id,
      choice,
      decidedAt: Date.now(),
      source: 'agent-island'
    },
    null,
    2
  )
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, target)
}

export async function writeHeartbeat(root = bridgeRoot()): Promise<void> {
  await ensureBridgeDirs(root)
  await writeFile(
    join(root, 'heartbeat.json'),
    JSON.stringify({ alive: true, at: Date.now(), app: 'agent-island' }),
    'utf8'
  )
}

export async function scanPending(root = bridgeRoot()): Promise<BridgePendingFile[]> {
  const dir = pendingDir(root)
  if (!existsSync(dir)) return []
  const names = await readdir(dir)
  const out: BridgePendingFile[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await readFile(join(dir, name), 'utf8')
      // Anything writing this file from PowerShell, .NET or a Windows editor is
      // likely to emit UTF-8 with a BOM, and JSON.parse rejects the leading
      // U+FEFF. Silently dropping those requests means an agent waits forever
      // for a decision the island never showed.
      const parsed = JSON.parse(stripBom(raw)) as BridgePendingFile
      if (parsed?.id && parsed?.command) out.push(parsed)
    } catch (error) {
      console.warn(`Ignoring unreadable approval request ${name}:`, error)
    }
  }
  return out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
}

export async function removePending(id: string, root = bridgeRoot()): Promise<void> {
  try {
    await unlink(join(pendingDir(root), `${id}.json`))
  } catch {
    // already gone
  }
}

export class ApprovalBridgeWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private known = new Map<string, BridgePendingFile>()
  private readonly root: string

  constructor(root = bridgeRoot()) {
    super()
    this.root = root
  }

  /** Which bridge this watcher serves; decisions must be written back to it. */
  get rootPath(): string {
    return this.root
  }

  async start(): Promise<void> {
    await ensureBridgeDirs(this.root)
    await writeHeartbeat(this.root)
    await this.refresh()

    const dir = pendingDir(this.root)
    try {
      this.watcher = watch(dir, { persistent: true }, () => {
        void this.refresh()
      })
    } catch {
      // fall back to poll only
    }

    this.pollTimer = setInterval(() => {
      void this.refresh()
    }, 1500)

    this.heartbeatTimer = setInterval(() => {
      void writeHeartbeat(this.root)
    }, 5000)
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.pollTimer = null
    this.heartbeatTimer = null
  }

  list(): ApprovalRequest[] {
    return [...this.known.values()].map(bridgePendingToApproval)
  }

  private async refresh(): Promise<void> {
    const files = await scanPending(this.root)
    const next = new Map(files.map((f) => [f.id, f]))

    for (const [id, file] of next) {
      if (!this.known.has(id)) {
        this.known.set(id, file)
        this.emit('raised', bridgePendingToApproval(file))
      }
    }
    for (const id of [...this.known.keys()]) {
      if (!next.has(id)) {
        const prev = this.known.get(id)!
        this.known.delete(id)
        this.emit('cleared', bridgePendingToApproval(prev))
      }
    }
  }
}
