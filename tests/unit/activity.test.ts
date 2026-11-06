import { describe, expect, it } from 'vitest'
import { describeActivity } from '../../src/shared/activity'
import { latestActivity } from '../../src/shared/session-list'
import {
  ACTIVITY_TTL_MS,
  parseActivityRecord,
  type AgentSessionRecord
} from '../../src/shared/session-registry'

const cmd = (command: string) => describeActivity('Bash', { command })

describe('what the pill says an agent is doing', () => {
  it('names the file, not the path', () => {
    expect(describeActivity('Edit', { file_path: 'C:/work/src/App.tsx' })).toBe('Editing App.tsx')
    expect(describeActivity('Write', { file_path: '/repo/notes.md' })).toBe('Writing notes.md')
    expect(describeActivity('Read', { file_path: 'README.md' })).toBe('Reading README.md')
  })

  it('gives known tools their subcommand', () => {
    expect(cmd('npm test -- --run')).toBe('Running npm test')
    expect(cmd('git push origin main')).toBe('Running git push')
  })

  it('names the program from a path, without its extension', () => {
    expect(cmd('C:/tools/ffmpeg.exe -i a.mp4')).toBe('Running ffmpeg')
  })

  it('reads a PowerShell call the same way', () => {
    expect(describeActivity('PowerShell', { command: 'npm run build' })).toBe('Running npm run')
  })

  it('names search, web and agent tools plainly', () => {
    expect(describeActivity('Grep', { pattern: 'token' })).toBe('Searching')
    expect(describeActivity('WebFetch', { url: 'https://example.com/?key=abc' })).toBe('Reading the web')
    expect(describeActivity('Agent', { prompt: 'do things' })).toBe('Running a subagent')
    expect(describeActivity('mcp__github__create_issue', {})).toBe('Using github')
  })

  it('falls back to the tool name', () => {
    expect(describeActivity('SomethingNew', {})).toBe('Using SomethingNew')
  })

  it('copes with missing input', () => {
    expect(describeActivity('Edit', undefined)).toBe('Editing a file')
    expect(describeActivity('Bash', {})).toBe('Running a command')
    expect(cmd('   ')).toBe('Running a command')
  })

  it('stays short', () => {
    const label = describeActivity('Edit', { file_path: `${'a'.repeat(120)}.ts` })
    expect(label.length).toBeLessThanOrEqual(36)
  })
})

/** This sits on top of the screen, so a command's arguments must never reach it. */
describe('secrets never reach the pill', () => {
  it.each([
    ['curl -H "Authorization: Bearer sk-abc123" https://api.test', 'Running curl'],
    ['API_KEY=sk-abc123 npm test', 'Running npm test'],
    ['deploy sk-abc123', 'Running deploy'],
    ['mysql -u root -phunter2 prod', 'Running mysql'],
    ['gh auth login --with-token sk-abc123', 'Running gh auth'],
    ['git sk-abc123', 'Running git']
  ])('%s', (command, expected) => {
    expect(cmd(command)).toBe(expected)
    expect(cmd(command)).not.toContain('abc123')
    expect(cmd(command)).not.toContain('hunter2')
  })
})

describe('reading an activity record', () => {
  const now = 1_000_000_000

  it('keeps a fresh record', () => {
    expect(parseActivityRecord(JSON.stringify({ label: ' Running npm test ', at: now - 5000 }), now)).toEqual({
      label: 'Running npm test',
      at: now - 5000
    })
  })

  it('drops one from a session that died without saying so', () => {
    expect(parseActivityRecord(JSON.stringify({ label: 'x', at: now - ACTIVITY_TTL_MS - 1 }), now)).toBeNull()
  })

  it.each(['not json', 'null', '{}', '{"label":3,"at":1}', '{"label":"  ","at":1000000000}'])('rejects %s', (raw) => {
    expect(parseActivityRecord(raw, now)).toBeNull()
  })

  it('caps a long label from a file it does not trust', () => {
    const label = parseActivityRecord(JSON.stringify({ label: 'x'.repeat(500), at: now }), now)?.label
    expect(label?.length).toBe(60)
  })
})

describe('choosing what the pill shows', () => {
  const session = (agentId: string, activity?: { label: string; at: number }) =>
    ({ agentId, activity }) as unknown as AgentSessionRecord

  it('takes the newest activity for that agent', () => {
    const sessions = [
      session('claude', { label: 'older', at: 1 }),
      session('claude', { label: 'newer', at: 2 }),
      session('codex', { label: 'other agent', at: 3 })
    ]
    expect(latestActivity(sessions, 'claude')).toBe('newer')
  })

  it('is empty when nothing is reporting', () => {
    expect(latestActivity([session('claude')], 'claude')).toBe('')
  })
})
