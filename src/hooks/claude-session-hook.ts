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
 *  - `pid` is the agent's own pid, from `CLAUDE_PID`. See `agentPid`: this used
 *    to be `process.ppid` and the comment here used to call that "the Claude
 *    process this hook was spawned by", which it never was. It is the shell
 *    Claude spawns to *run* the hook, dead before the hook's output is read.
 *  - `hwnd` is null. There is no window to raise — a webview panel is not
 *    something an outside process can focus — and claiming otherwise would put
 *    a "Continue in Terminal" button on a session that has no terminal.
 *
 * `SessionEnd` was observed not to fire for a headless (`-p`) run, so the record
 * can outlive its session; the watcher reaps one whose heartbeat is stale and
 * whose pid is gone. The note that used to sit here read "a dead one disappears
 * within seconds. Measured at five" as evidence that worked. It was measuring
 * the bug: the pid was always dead, so what disappeared within seconds was every
 * *live* session too.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readStdin } from './bridge-client'
import { agentPid, clearActivity, wrapperOwnsThisSession } from './mirror-store'
import { clearSessionCalls } from '../node/pending-calls'
import { isSafeFileId } from '../shared/session-registry'

function registryRoot(): string {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(local, 'agent-island')
}

/** Hooks must never break the session; every path exits 0 with no output. */
function done(): never {
  process.exit(0)
}

function main(): void {
  // Read first, even to stand down. Claude Code is writing this payload, and
  // exiting before it finishes hands that write a broken pipe.
  const raw = readStdin()
  /*
   * A wrapper already publishes this session, with a real window handle and a
   * terminal kind this hook can only guess at. Publishing again produced a
   * second row for one agent — the duplicate reading `vscode` / `hwnd: null`
   * even for a Windows Terminal session, so the wrong one offered no handoff.
   */
  if (wrapperOwnsThisSession()) done()

  let payload: { session_id?: string; cwd?: string; hook_event_name?: string; source?: string }
  try {
    payload = JSON.parse(raw.replace(/^﻿/, '')) as typeof payload
  } catch {
    done()
  }
  if (!payload || typeof payload !== 'object') done()

  // Goes straight into a file name, so it gets the same check every other id does.
  const sessionId = isSafeFileId(payload.session_id) ? payload.session_id : ''
  if (!sessionId) done()

  const dir = join(registryRoot(), 'sessions')
  // Prefixed so a hook-registered session can never collide with a wrapper's,
  // and so it is obvious in the registry which mechanism published it.
  const file = join(dir, `claude-hook-${sessionId}.json`)

  if (payload.hook_event_name === 'SessionEnd') {
    clearActivity(`claude-hook-${sessionId}`)
    try {
      rmSync(file, { force: true })
      // Anything still open belonged to a session that no longer exists. The
      // TTL would clear it eventually; leaving a card up for ten minutes after
      // the chat closed is not "eventually" enough.
      clearSessionCalls(sessionId)
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
          // The agent itself, not the shell that ran this hook — see `agentPid`.
          pid: agentPid(),
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
