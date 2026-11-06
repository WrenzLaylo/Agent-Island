import { describe, expect, it } from 'vitest'
import { removeAgentIslandAutoRun, toNativeNodePath } from '../../src/main/agents/shell-shims'

describe('Git Bash native executable paths', () => {
  it('keeps a Windows drive path that Node can resolve when MSYS conversion is disabled', () => {
    expect(toNativeNodePath('C:\\Users\\me\\agent-island\\out\\main\\wrapper.js')).toBe(
      'C:/Users/me/agent-island/out/main/wrapper.js'
    )
  })
})

describe('cmd AutoRun cleanup', () => {
  it('removes only Agent Island while preserving ampersands inside quotes', () => {
    const existing =
      'call "C:\\Program Files\\A&B\\startup.cmd" & if exist "C:\\Users\\x\\cmd-autorun.cmd" call "C:\\Users\\x\\cmd-autorun.cmd" & set READY=1'
    expect(removeAgentIslandAutoRun(existing)).toBe(
      'call "C:\\Program Files\\A&B\\startup.cmd" & set READY=1'
    )
  })

  it('preserves escaped ampersands in unrelated commands', () => {
    const existing =
      'set LABEL=A^&B & if exist "C:\\Users\\x\\cmd-autorun.cmd" call "C:\\Users\\x\\cmd-autorun.cmd"'
    expect(removeAgentIslandAutoRun(existing)).toBe('set LABEL=A^&B')
  })
})