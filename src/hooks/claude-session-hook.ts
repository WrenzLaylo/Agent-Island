/**
 * Registers a Claude Code session that Agent Island did not launch.
 *
 * The island learns about sessions from the `island` wrapper, which publishes a
 * record and heartbeats it. The VS Code extension spawns its own `claude.exe`,
 * so no wrapper exists and the island shows "Run island claude in a terminal"
 * while quite happily answering that session's approvals through the hook —
 * plainly contradicting itself.
 *
 * `SessionStart` and `SessionEnd` fix that: they bracket the real lifetime of a
 * session, which is more accurate than anything inferred from tool calls.
 *
 * Two details make the record survive without a wrapper to tend it:
 *
 *  - `pid` is `process.ppid`, the Claude process this hook was spawned by. The
 *    watcher only reaps a stale session whose pid is also gone, so a live
 *    session is never reaped even though nothing heartbeats it.
 *  - `hwnd` is null. There is no window to raise — a webview panel is not
 *    something an outside process can focus — and claiming otherwise would put
 *    a "Continue in Terminal" button on a session that has no terminal.
 *
 * `SessionEnd` was observed not to fire for a headless (`-p`) run, so the
 * record can outlive its session. That is survivable rather than fixed: the
 * watcher reaps any session whose heartbeat is stale *and* whose pid is gone,
 * and nothing heartbeats these, so a dead one disappears within seconds.
 * Measured at five. SessionEnd is kept because it removes the record promptly
 * when it does fire.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readStdin } from './bridge-client'

function registryRoot(): string {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(local, 'agent-island')
}

/** Hooks must never break the session; every path exits 0 with no output. */
function done(): never {
  process.exit(0)
}

function main(): void {
  let payload: { session_id?: string; cwd?: string; hook_event_name?: string; source?: string }
  try {
    payload = JSON.parse(readStdin().replace(/^﻿/, '')) as typeof payload
  } catch {
    done()
  }
  if (!payload || typeof payload !== 'object') done()

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
  if (!sessionId) done()

  const dir = join(registryRoot(), 'sessions')
  // Prefixed so a hook-registered session can never collide with a wrapper's,
  // and so it is obvious in the registry which mechanism published it.
  const file = join(dir, `claude-hook-${sessionId}.json`)

  if (payload.hook_event_name === 'SessionEnd') {
    try {
      rmSync(file, { force: true })
    } catch {
      // A session record that outlives its session is reaped by age anyway.
    }
    done()
  }

  const now = Date.now()
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      file,
      JSON.stringify(
        {
          id: `claude-hook-${sessionId}`,
          agentId: 'claude',
          // The Claude process that spawned this hook. Its liveness is what
          // keeps the record from being reaped.
          pid: process.ppid,
          hwnd: null,
          terminalKind: 'vscode',
          terminalLabel: 'Claude Code (no terminal)',
          cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
          startedAt: now,
          heartbeatAt: now,
          busy: false
        },
        null,
        2
      ),
      'utf8'
    )
  } catch {
    // Nothing here is worth failing a session start over.
  }
  done()
}

try {
  main()
} catch {
  done()
}
