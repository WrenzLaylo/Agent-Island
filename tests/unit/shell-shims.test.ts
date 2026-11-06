import { describe, expect, it } from 'vitest'
import { toNativeNodePath } from '../../src/main/agents/shell-shims'

describe('Git Bash native executable paths', () => {
  it('keeps a Windows drive path that Node can resolve when MSYS conversion is disabled', () => {
    expect(toNativeNodePath('C:\\Users\\me\\agent-island\\out\\main\\wrapper.js')).toBe(
      'C:/Users/me/agent-island/out/main/wrapper.js'
    )
  })
})
