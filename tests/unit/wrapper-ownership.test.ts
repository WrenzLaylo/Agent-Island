/**
 * A wrapper-hosted session must be left entirely to its wrapper.
 *
 * The regression these cover: the island's hooks published a session and a
 * card for a CLI session that an `island` wrapper had launched. The wrapper's
 * card carries the real choices and can be answered; the hook's is a `handoff`
 * with no options at all, and it landed on top. A session that had always been
 * answerable from the island stopped offering anything to click.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { wrapperOwnsThisSession, wrapperSessionId } from '../../src/hooks/mirror-store'

const VAR = 'AGENT_ISLAND_SESSION'

afterEach(() => {
  delete process.env[VAR]
})

describe('wrapperSessionId', () => {
  it('reads the id the wrapper exports to its child', () => {
    // Captured live from a hook running under wrapper 6cf53b71.
    process.env[VAR] = '6cf53b71-a4ef-4602-a4bb-f73d290458de'
    expect(wrapperSessionId()).toBe('6cf53b71-a4ef-4602-a4bb-f73d290458de')
  })

  it('is empty for a session no wrapper launched', () => {
    expect(wrapperSessionId()).toBe('')
  })

  it('treats whitespace as absent, not as an id', () => {
    process.env[VAR] = '   '
    expect(wrapperSessionId()).toBe('')
    expect(wrapperOwnsThisSession()).toBe(false)
  })
})

describe('wrapperOwnsThisSession', () => {
  it('stands down when a wrapper owns the session', () => {
    process.env[VAR] = '6cf53b71-a4ef-4602-a4bb-f73d290458de'
    expect(wrapperOwnsThisSession()).toBe(true)
  })

  /*
   * The VS Code extension spawns its own claude.exe with no wrapper anywhere,
   * so nothing exports the variable and the hooks are the only mechanism that
   * can see the session at all.
   */
  it('does the work itself when no wrapper is present', () => {
    expect(wrapperOwnsThisSession()).toBe(false)
  })

  /*
   * The point of the fix. Ownership used to be inferred by comparing the
   * wrapper's cwd with the hook's, which agree only until someone changes
   * directory: wrapper 6cf53b71 recorded `the home folder` while its own child
   * claude reported `the repo folder`. The environment
   * variable is unaffected by that, because it is set once at spawn.
   */
  it('is unaffected by the session changing directory', () => {
    process.env[VAR] = '6cf53b71-a4ef-4602-a4bb-f73d290458de'
    const before = wrapperOwnsThisSession()
    const cwd = process.cwd()
    try {
      process.chdir(require('node:os').tmpdir())
      expect(wrapperOwnsThisSession()).toBe(before)
    } finally {
      process.chdir(cwd)
    }
  })
})
