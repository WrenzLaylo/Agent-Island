import { describe, expect, it } from 'vitest'
import { parseSessionRecord } from '../../src/shared/session-registry'

/**
 * Three files exactly like this were found in the live registry: 291 bytes of
 * NUL, dated days apart. NTFS leaves this shape behind when a file's length is
 * extended but its contents never reach disk before a hard shutdown.
 *
 * They were skipped on every poll and reaped by nothing, because the reaper
 * needs a parsed record to find a pid to test. The watcher now falls back to
 * file age for records it cannot read at all.
 */
const NUL_FILE = String.fromCharCode(0).repeat(291)

describe('corrupt session records', () => {
  it('does not parse a NUL-filled file as a session', () => {
    expect(parseSessionRecord(NUL_FILE)).toBeNull()
  })

  it('does not throw on the shapes a partial write can leave', () => {
    // A wrapper interrupted mid-write leaves valid JSON prefixes, empty files
    // and BOM-only files. None may take down the poll loop.
    for (const raw of ['', '{', '{"id":', '\uFEFF', '\uFEFF{"id":"x"', 'null', '[]', '   ']) {
      expect(() => parseSessionRecord(raw)).not.toThrow()
      expect(parseSessionRecord(raw)).toBeNull()
    }
  })

  it('still accepts a well-formed record with a BOM', () => {
    // Windows editors add one freely, and rejecting it would reap live sessions.
    const record = {
      id: 'abc',
      agentId: 'claude',
      pid: 4321,
      hwnd: 66818,
      terminalKind: 'windows-terminal',
      terminalLabel: 'Windows Terminal',
      cwd: 'C:\\Users\\OASIS',
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
      busy: false
    }
    const parsed = parseSessionRecord('\uFEFF' + JSON.stringify(record))
    expect(parsed?.id).toBe('abc')
    expect(parsed?.pid).toBe(4321)
  })
})
