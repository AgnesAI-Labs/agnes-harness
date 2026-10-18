/** @vitest-environment happy-dom */
import type { ITerminalOptions } from '@xterm/xterm'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { renderRegion, unmountRegion } from '../src/regions.js'
import { terminalDocument } from '../src/terminal/document.js'
import { snapshotDelta, terminalPaste } from '../src/terminal/snapshot.js'
import { TerminalScreen, type TerminalScreenProps } from '../src/terminal/terminal.js'

type MockEmulator = {
  options: ITerminalOptions
  textarea: HTMLTextAreaElement
  output: string
  disposed: boolean
  keys?: (event: KeyboardEvent) => boolean
  data(value: string): void
  osc: Map<number, (value: string) => boolean>
}
const mock = vi.hoisted(() => ({
  instances: [] as MockEmulator[],
  resize: (() => {}) as () => void,
  dimensions: { cols: 80, rows: 24 },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions() {
      return mock.dimensions
    }
  },
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: ITerminalOptions
    textarea = document.createElement('textarea')
    output = ''
    disposed = false
    dimensions: number[] = []
    keys?: (event: KeyboardEvent) => boolean
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keys = handler
    }
    data: (value: string) => void = () => {}
    osc = new Map<number, (value: string) => boolean>()
    parser = {
      registerOscHandler: (id: number, fn: (value: string) => boolean) => {
        this.osc.set(id, fn)
        return { dispose: () => this.osc.delete(id) }
      },
    }
    constructor(options: ITerminalOptions) {
      this.options = options
      mock.instances.push(this)
    }
    open(node: HTMLElement) {
      node.append(this.textarea)
    }
    loadAddon() {}
    onData(fn: (value: string) => void) {
      this.data = fn
      return {
        dispose: () => {
          this.data = () => {}
        },
      }
    }
    focus() {
      this.textarea.focus()
    }
    resize(cols: number, rows: number) {
      this.dimensions = [cols, rows]
    }
    write(text: string) {
      this.output += text
    }
    reset() {
      this.output = ''
    }
    dispose() {
      this.disposed = true
      this.textarea.remove()
    }
  },
}))
let host: HTMLDivElement | undefined
function mount(extra: Partial<TerminalScreenProps> = {}) {
  const props: TerminalScreenProps = {
    stdout: '\x1b[32mhello\x1b[0m',
    stderr: '',
    label: 'Terminal',
    writable: true,
    onData: vi.fn(),
    onResize: vi.fn(),
    ...extra,
  }
  host = document.createElement('div')
  document.body.append(host)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(fn: () => void) {
        mock.resize = fn
      }
      observe() {}
      disconnect() {}
    },
  )
  const draw = () => {
    if (host) renderRegion(host, <TerminalScreen {...props} />)
  }
  draw()
  const terminal = mock.instances.at(-1)
  if (!terminal) throw new Error('Emulator did not mount')
  return {
    props,
    draw,
    terminal,
    node: host.querySelector('.agh-terminal-screen') as HTMLElement,
  }
}
afterEach(() => {
  if (host) {
    unmountRegion(host)
    host.remove()
    host = undefined
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('style')
  mock.instances.length = 0
})

it('writes raw snapshot increments once, preserves split escapes, handles rolling tails and replacement, and appends exit once', () => {
  const { props, draw, terminal } = mount({ stdout: '\x1b[3' })
  props.stdout += '2mgreen'
  draw()
  expect(terminal.output).toBe('\x1b[32mgreen')
  props.stdout = '2mgreen suffix'
  draw()
  expect(terminal.output).toBe('\x1b[32mgreen suffix')
  draw()
  expect(terminal.output).toBe('\x1b[32mgreen suffix')
  props.stdout = 'replacement'
  props.exitLine = 'Process exited (1)'
  props.exitTone = 'danger'
  draw()
  expect(terminal.output).toContain('replacement\r\n\x1b[0m\x1b[31mProcess exited (1)')
  const finished = terminal.output
  draw()
  expect(terminal.output).toBe(finished)
  props.stdout += ' final output'
  draw()
  expect(terminal.output).toContain('replacement final output\r\n\x1b[0m\x1b[31mProcess exited (1)')
  expect(snapshotDelta('aaaab', 'aabtail')).toEqual({ reset: false, text: 'tail' })
})

it('forwards xterm input and capped paste, resizes from fit, blocks Agent input/resize and disposes without ending a process', () => {
  const { props, draw, terminal, node } = mount()
  expect(terminal.options.screenReaderMode).toBe(true)
  expect(terminal.keys?.(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(false)
  expect(terminal.keys?.(new KeyboardEvent('keydown', { key: 'F6' }))).toBe(false)
  expect(terminal.keys?.(new KeyboardEvent('keydown', { key: 'Tab' }))).toBe(true)
  expect(terminal.textarea.getAttribute('aria-label')).toBe('Terminal')
  Object.defineProperties(node, { clientWidth: { value: 600 }, clientHeight: { value: 400 } })
  mock.resize()
  expect(props.onResize).toHaveBeenCalledWith(80, 24)
  terminal.data('ls\r')
  expect(props.onData).toHaveBeenCalledWith('ls\r')
  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'a'.repeat(70000) } })
  node.dispatchEvent(paste)
  expect(props.onData).toHaveBeenLastCalledWith('a'.repeat(65536))
  expect(paste.defaultPrevented).toBe(true)
  expect(new TextEncoder().encode(terminalPaste('中'.repeat(30000))).length).toBe(65535)
  expect(terminalPaste('😀'.repeat(30000)).length).toBe(32768)
  props.writable = false
  draw()
  vi.mocked(props.onData).mockClear()
  vi.mocked(props.onResize).mockClear()
  terminal.data('refused')
  node.dispatchEvent(paste)
  mock.dimensions = { cols: 100, rows: 30 }
  mock.resize()
  expect(props.onData).not.toHaveBeenCalled()
  expect(props.onResize).not.toHaveBeenCalled()
  expect(terminal.options.disableStdin).toBe(true)
  props.writable = true
  draw()
  expect(terminal.options.cursorBlink).toBe(true)
  terminal.data('writable again')
  expect(props.onData).toHaveBeenCalledWith('writable again')
  if (host) unmountRegion(host)
  expect(terminal.disposed).toBe(true)
  expect(terminal.osc.size).toBe(0)
})

it('follows runtime theme defaults while retaining OSC overrides and resets, and blinks only in focus without reduced motion', async () => {
  const media = new Map<string, { matches: boolean; listener: (() => void) | undefined }>()
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const state = { matches: false, listener: undefined as (() => void) | undefined }
    media.set(query, state)
    return {
      get matches() {
        return state.matches
      },
      addEventListener: (_: string, fn: () => void) => {
        state.listener = fn
      },
      removeEventListener() {},
    } as unknown as MediaQueryList
  })
  const { terminal, node } = mount()
  expect(terminal.options.cursorBlink).toBe(true)
  flushSync(() => terminal.textarea.blur())
  expect(terminal.options.cursorBlink).toBe(false)
  terminal.textarea.focus()
  expect(terminal.options.cursorBlink).toBe(true)
  const reduce = media.get('(prefers-reduced-motion: reduce)')
  if (!reduce) throw new Error('missing motion observer')
  reduce.matches = true
  reduce.listener?.()
  expect(terminal.options.cursorBlink).toBe(false)
  node.style.color = 'rgb(10, 20, 30)'
  node.style.backgroundColor = 'rgb(240, 240, 240)'
  await vi.waitFor(() => expect(terminal.options.theme?.foreground).toBe('rgb(10, 20, 30)'))
  expect(terminal.osc.get(10)?.('rgb:ff/00/00')).toBe(false)
  terminal.osc.get(4)?.('2;#0f0;200;rgb:00/ff/00')
  node.style.backgroundColor = 'rgb(20, 20, 20)'
  await vi.waitFor(() => expect(terminal.options.theme?.background).toBe('rgb(20, 20, 20)'))
  expect(terminal.options.theme?.foreground).toBe('#ff0000')
  expect(terminal.options.theme?.green).toBe('#00f000')
  expect(terminal.options.theme?.extendedAnsi?.[184]).toBe('#00ff00')
  terminal.osc.get(110)?.('')
  terminal.osc.get(104)?.('')
  expect(terminal.options.theme?.foreground).toBe('rgb(10, 20, 30)')
  expect(terminal.options.theme?.green).toBeUndefined()
  vi.restoreAllMocks()
})

it.each(['tablist', 'listbox', 'toolbar'])(
  'keeps roving focus when a terminal is mounted from keyboard navigation in %s',
  (role) => {
    const tablist = document.createElement('div'),
      tab = document.createElement('button')
    tablist.setAttribute('role', role)
    if (role !== 'toolbar') tab.setAttribute('role', role === 'listbox' ? 'option' : 'tab')
    tablist.append(tab)
    document.body.append(tablist)
    tab.focus()
    try {
      const { terminal } = mount()
      expect(document.activeElement).toBe(tab)
      expect(terminal.options.cursorBlink).toBe(false)
    } finally {
      tablist.remove()
    }
  },
)

it('authorizes only xterm styles with the document nonce and uses CSSOM for cell colors', () => {
  const meta = document.createElement('meta')
  meta.name = 'agnes-csp-nonce'
  meta.content = 'synthetic-nonce'
  document.head.append(meta)
  try {
    const scoped = terminalDocument(document)
    // happy-dom's own HTMLDocument is not an instanceof its Window.Document.
    expect(scoped instanceof Document).toBe(document instanceof Document)
    expect(Object.getPrototypeOf(scoped)).toBe(Object.getPrototypeOf(document))
    expect(scoped.body).toBe(document.body)
    const style = scoped.createElement('style')
    expect(style.getAttribute('nonce')).toBe('synthetic-nonce')
    style.textContent = '.xterm { color: red }'
    expect(style.textContent).toBe('@layer vendor {\n.xterm { color: red }\n}')
    style.textContent = '.xterm { color: blue }'
    expect(style.textContent).not.toContain('red')
    const span = scoped.createElement('span')
    span.setAttribute('style', 'color: rgb(255, 0, 0)')
    expect(span.style.color).toBe('rgb(255, 0, 0)')
    span.setAttribute('aria-label', 'cell')
    expect(span.getAttribute('aria-label')).toBe('cell')
    expect(document.createElement('style').getAttribute('nonce')).toBeNull()
  } finally {
    meta.remove()
  }
})
