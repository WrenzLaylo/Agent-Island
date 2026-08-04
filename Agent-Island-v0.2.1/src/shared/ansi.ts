/** Strip CSI/OSC ANSI sequences so detectors can match plain text. */
export function stripAnsi(input: string): string {
  return input
    // OSC sequences: ESC ] ... BEL or ST
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    // CSI sequences
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // simple charset / single-char escapes
    .replace(/\u001b[()][0-9A-Za-z]/g, '')
    .replace(/\u001b[>=NO]/g, '')
}

export function normalizeTerminalText(input: string): string {
  return stripAnsi(input)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // box-drawing noise collapse
    .replace(/\u00a0/g, ' ')
}
