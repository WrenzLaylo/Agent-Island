import { folderName } from './session-list'

const MAX_LABEL = 36

/**
 * Tools whose second word is a subcommand rather than an argument. An allow-list
 * because the alternative is guessing what looks harmless, and an argument is
 * exactly where a token ends up.
 */
const SUBCOMMANDS: Record<string, readonly string[]> = {
  git: ['add', 'checkout', 'clone', 'commit', 'diff', 'fetch', 'log', 'merge', 'pull', 'push', 'rebase', 'status', 'switch'],
  npm: ['ci', 'install', 'run', 'test'],
  pnpm: ['install', 'run', 'test'],
  yarn: ['install', 'run', 'test'],
  gh: ['api', 'auth', 'issue', 'pr', 'repo', 'run'],
  docker: ['build', 'compose', 'pull', 'push', 'run'],
  cargo: ['build', 'check', 'run', 'test']
}

function shorten(label: string): string {
  return label.length <= MAX_LABEL ? label : `${label.slice(0, MAX_LABEL - 1)}…`
}

function fileName(input: Record<string, unknown> | undefined): string {
  const path = input?.file_path ?? input?.notebook_path
  return typeof path === 'string' ? folderName(path) : ''
}

/**
 * The program and, for known tools, its subcommand. Nothing else: this text sits
 * on top of the screen, and a command's arguments can hold a token or a password.
 */
function describeCommand(command: unknown): string {
  if (typeof command !== 'string') return 'Running a command'
  const words = command.trim().split('\n')[0].split(' ').filter(Boolean)
  // `API_KEY=abc npm test`: the assignments are the part to lose.
  const start = words.findIndex((word) => !word.includes('='))
  if (start < 0) return 'Running a command'
  const program = folderName(words[start].replace(/^["']|["']$/g, '')).replace(/\.(exe|cmd|bat)$/i, '')
  // `$s = ...`, `& "x.exe"` and `(Get-Item .)` are shell syntax, not programs.
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(program)) return 'Running a command'
  const next = words[start + 1]
  const known = Object.hasOwn(SUBCOMMANDS, program) ? SUBCOMMANDS[program] : []
  return known.includes(next) ? `Running ${program} ${next}` : `Running ${program}`
}

/** One short line for the pill, from what a tool call is about to do. */
export function describeActivity(toolName: string, input: Record<string, unknown> | undefined): string {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return shorten(describeCommand(input?.command))
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return shorten(`Editing ${fileName(input) || 'a file'}`)
    case 'Write':
      return shorten(`Writing ${fileName(input) || 'a file'}`)
    case 'Read':
      return shorten(`Reading ${fileName(input) || 'a file'}`)
    case 'Grep':
    case 'Glob':
      return 'Searching'
    case 'WebFetch':
    case 'WebSearch':
      return 'Reading the web'
    case 'Agent':
    case 'Task':
      return 'Running a subagent'
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(toolName)
  return shorten(`Using ${mcp ? mcp[1] : toolName}`)
}
