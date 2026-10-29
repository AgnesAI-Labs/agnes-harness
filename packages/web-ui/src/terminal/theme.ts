import type { IDisposable, ITheme, Terminal } from '@xterm/xterm'

const ansi: (keyof ITheme)[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
]
const special = ['foreground', 'background', 'cursor'] as const

// OSC uses XParseColor notation, whose short hex channels differ from CSS short hex.
function color(value: string | undefined): string | undefined {
  if (!value) return
  const rgb = /^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/i.exec(value)
  const hex = /^#([\da-f]{3}|[\da-f]{6}|[\da-f]{9}|[\da-f]{12})$/i.exec(value)?.[1]
  const width = hex ? hex.length / 3 : 0
  const channels = rgb
    ? rgb.slice(1)
    : hex
      ? [hex.slice(0, width), hex.slice(width, width * 2), hex.slice(width * 2)]
      : []
  if (channels.length !== 3 || !channels.every((part) => part.length === channels[0]?.length)) return
  return `#${channels
    .map((part) => {
      const byte = rgb
        ? Math.round((parseInt(part, 16) * 255) / (16 ** part.length - 1))
        : parseInt(part.padEnd(2, '0').slice(0, 2), 16)
      return byte.toString(16).padStart(2, '0')
    })
    .join('')}`
}

/** App defaults follow tokens; program-set OSC colors survive a runtime theme change. */
export class TerminalPalette {
  private base: ITheme = {}
  private overrides: ITheme = {}
  private indexed = new Map<number, string>()
  private listeners: IDisposable[] = []
  constructor(private terminal: Terminal) {
    const observe = (code: number, fn: (value: string) => void) => {
      this.listeners.push(
        terminal.parser.registerOscHandler(code, (value) => {
          fn(value)
          return false
        }),
      )
    }
    observe(4, (value) => {
      const parts = value.split(';')
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const index = Number(parts[i]),
          parsed = color(parts[i + 1])
        if (/^\d+$/.test(parts[i] ?? '') && index < 256 && parsed) this.indexed.set(index, parsed)
      }
    })
    observe(104, (value) => {
      if (!value) this.indexed.clear()
      else for (const index of value.split(';')) this.indexed.delete(Number(index))
      this.apply()
    })
    special.forEach((key, offset) => {
      observe(10 + offset, (value) => {
        value.split(';').forEach((part, i) => {
          const target = special[offset + i],
            parsed = color(part)
          if (target && parsed) this.overrides[target] = parsed
        })
      })
      observe(110 + offset, () => {
        delete this.overrides[key]
        this.apply()
      })
    })
  }
  update(background: string, foreground: string) {
    this.base = { background, foreground, cursor: foreground, cursorAccent: background }
    this.apply()
  }
  reset() {
    this.overrides = {}
    this.indexed.clear()
    this.apply()
  }
  dispose() {
    for (const listener of this.listeners) listener.dispose()
  }
  private apply() {
    const theme: ITheme = { ...this.base, ...this.overrides }
    for (const [index, value] of this.indexed) {
      const key = ansi[index]
      if (key) Object.assign(theme, { [key]: value })
      else {
        theme.extendedAnsi ??= []
        theme.extendedAnsi[index - 16] = value
      }
    }
    this.terminal.options.theme = theme
  }
}
