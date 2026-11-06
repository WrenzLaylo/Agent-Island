/**
 * Answering an approval from the keyboard.
 *
 * The digit on a numbered row is the one the agent printed, and it is what gets
 * sent, so the key has to match it rather than the row's position. Rows without
 * a digit are numbered by position.
 */
export interface KeyPress {
  key: string
  repeat?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
}

export function rowKey(row: { index: number | null }, position: number): number {
  return row.index ?? position + 1
}

export function rowForKey<Row extends { index: number | null }>(
  rows: readonly Row[],
  press: KeyPress
): Row | null {
  // A held key repeats, and a repeat must never answer the next request.
  if (press.repeat || press.ctrlKey || press.altKey || press.metaKey) return null
  if (!/^[1-9]$/.test(press.key)) return null
  const digit = Number(press.key)
  return rows.find((row, position) => rowKey(row, position) === digit) ?? null
}

/** A digit typed into a field is text, not an answer. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null
  return Boolean(element?.closest?.('input, textarea, select'))
}
