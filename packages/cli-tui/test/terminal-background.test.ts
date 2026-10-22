import { describe, expect, it, vi } from 'vitest'
import { ProvisionalComposer } from '../src/provisional-composer.js'
import { type InputStream, NodeTerminal, type OutputStream } from '../src/terminal.js'
import {
  type Background,
  BackgroundReplyFilter,
  backgroundFromEnv,
  parseBackground,
} from '../src/terminal-background.js'

const LIGHT = '\x1b]11;rgb:ffff/ffff/ffff\x07'
const DARK = '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\'

describe('terminal background detection', () => {
  it.each([
    ['rgb:ffff/ffff/ffff', 'light'],
    ['rgb:ff/ff/ff', 'light'],
    ['rgb:f/f/f', 'light'],
    ['rgb:0000/0000/0000', 'dark'],
    ['rgb:1e1e/1e1e/1e1e', 'dark'],
    ['rgb:fdfd/f6f6/e3e3', 'light'],
    ['nonsense', undefined],
  ])('reads %s as %s', (body, want) => expect(parseBackground(body)).toBe(want))

  it.each([
    ['0;15', 'light'],
    ['15;7', 'light'],
    ['0;default;15', 'light'],
    ['15;0', 'dark'],
    ['12;8', 'dark'],
    ['', undefined],
    ['x', undefined],
  ])('reads COLORFGBG=%s as %s', (v, want) => expect(backgroundFromEnv({ COLORFGBG: v })).toBe(want))

  it('takes the reply out of input however it is mixed or split, and reports it', () => {
    const seen: (Background | undefined)[] = []
    const f = new BackgroundReplyFilter((b) => seen.push(b))
    expect(f.push(`ab${LIGHT}cd`)).toBe('abcd')
    expect(f.push(DARK)).toBe('')
    expect(f.push('x\x1b]11;rgb:ff')).toBe('x')
    expect(f.push(`ff/ffff/ffff\x07y`)).toBe('y')
    expect(f.push('\x1b')).toBe('\x1b') // a lone Esc is a key and is never held
    expect(f.push('\x1b[A')).toBe('\x1b[A')
    expect(seen).toEqual(['light', 'dark', 'light'])
  })
})

function streams() {
  let handler: ((c: string | Buffer) => void) | undefined
  const stdin: InputStream = {
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    on: (_e, h) => {
      handler = h
    },
    off: () => {
      handler = undefined
    },
  }
  const out: string[] = []
  const stdout: OutputStream = {
    isTTY: true,
    columns: 80,
    rows: 12,
    write: (s) => void out.push(s),
    on() {},
    off() {},
  }
  return { stdin, stdout, out, emit: (d: string) => handler?.(d) }
}

describe('auto theme on a real terminal', () => {
  const env = { TERM: 'xterm-256color' }

  it('keeps the reply out of the draft, in time or late, and loses no typing', async () => {
    vi.useFakeTimers()
    try {
      const s = streams()
      const term = new NodeTerminal(s.stdin, s.stdout, env)
      const composer = new ProvisionalComposer(term, { locale: 'en', cwd: '/w', onInterrupt() {} })
      composer.start()
      expect(s.out.join('')).toContain('\x1b]11;?')
      s.emit('he')
      s.emit(`l${LIGHT}lo`)
      await vi.advanceTimersByTimeAsync(0)
      expect(composer.draft).toBe('hello')
      expect(term.background).toBe('light')
      s.emit(' wo')
      // A second terminal answer after the wait is over is still not typing.
      await vi.advanceTimersByTimeAsync(150)
      s.emit(`rld${DARK}!`)
      await vi.advanceTimersByTimeAsync(0)
      expect(composer.draft).toBe('hello world!')
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out at 100 ms and falls back to COLORFGBG', async () => {
    vi.useFakeTimers()
    try {
      const s = streams()
      const term = new NodeTerminal(s.stdin, s.stdout, { ...env, COLORFGBG: '0;15' })
      const answer = term.queryBackground()
      await vi.advanceTimersByTimeAsync(100)
      await expect(answer).resolves.toBe('light')
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends no query to a non-TTY or with NO_COLOR', async () => {
    const pipe = streams()
    pipe.stdout.isTTY = false
    await new NodeTerminal(pipe.stdin, pipe.stdout, env).queryBackground()
    const plain = streams()
    await new NodeTerminal(plain.stdin, plain.stdout, { ...env, NO_COLOR: '1' }).queryBackground()
    expect(pipe.out).toEqual([])
    expect(plain.out).toEqual([])
  })
})
