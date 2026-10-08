/** A bounded plain-text VT screen. SGR/OSC are ignored; terminal bytes never become HTML. */
export function terminalScreen(text: string, columns = 100, rows = 30): string {
  const lines: string[][] = [[]]
  let x = 0,
    y = 0,
    saved = { x: 0, y: 0 }
  const line = () => {
    while (lines.length <= y) lines.push([])
    return lines[y]!
  }
  const move = (nextX: number, nextY: number) => {
    x = Math.max(0, Math.min(columns - 1, nextX))
    y = Math.max(0, Math.min(4095, nextY))
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this parser recognizes the VT protocol control bytes.
  const tokens = text.match(/\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b.|[^\x1b]/gs) ?? []
  for (const token of tokens) {
    if (token.startsWith('\x1b[')) {
      const command = token.at(-1),
        args = token
          .slice(2, -1)
          .replace(/^\?/, '')
          .split(';')
          .map((v) => Number(v) || 0),
        n = args[0] || 1
      if (command === 'A') move(x, y - n)
      else if (command === 'B') move(x, y + n)
      else if (command === 'C') move(x + n, y)
      else if (command === 'D') move(x - n, y)
      else if (command === 'G') move(n - 1, y)
      else if (command === 'H' || command === 'f') move((args[1] || 1) - 1, n - 1)
      else if (command === 'J' && (args[0] === 2 || args[0] === 3)) {
        lines.length = 0
        move(0, 0)
      } else if (command === 'K') {
        if (args[0] === 2) lines[y] = []
        else if (args[0] === 1) for (let i = 0; i <= x; i++) line()[i] = ' '
        else line().length = Math.min(line().length, x)
      } else if (command === 's') saved = { x, y }
      else if (command === 'u') move(saved.x, saved.y)
      continue
    }
    if (token.startsWith('\x1b')) continue
    if (token === '\r') x = 0
    else if (token === '\n') {
      y++
      line()
    } else if (token === '\b') x = Math.max(0, x - 1)
    else if (token === '\t') x = Math.min(columns - 1, (Math.floor(x / 8) + 1) * 8)
    else if (token >= ' ' && token !== '\x7f') {
      while (line().length < x) line().push(' ')
      line()[x++] = token
      if (x >= columns) {
        x = 0
        y++
        line()
      }
    }
    if (lines.length > 4096) {
      lines.shift()
      y--
      saved.y = Math.max(0, saved.y - 1)
    }
  }
  return lines
    .slice(-Math.max(rows, 300))
    .map((cells) => cells.join(''))
    .join('\n')
}
export function terminalKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>,
): string | undefined {
  if (event.metaKey || (event.ctrlKey && event.key.toLowerCase() === 'v')) return undefined
  if (event.ctrlKey && event.key.length === 1)
    return String.fromCharCode(event.key.toUpperCase().charCodeAt(0) & 31)
  const keys: Record<string, string> = {
    Enter: '\r',
    Backspace: '\x7f',
    Tab: '\t',
    Escape: '\x1b',
    ArrowUp: '\x1b[A',
    ArrowDown: '\x1b[B',
    ArrowRight: '\x1b[C',
    ArrowLeft: '\x1b[D',
    Home: '\x1b[H',
    End: '\x1b[F',
    Delete: '\x1b[3~',
  }
  const value = keys[event.key] ?? (event.key.length === 1 ? event.key : undefined)
  return value === undefined ? undefined : (event.altKey ? '\x1b' : '') + value
}
