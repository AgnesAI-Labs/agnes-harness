import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEY_HOLD_MS, KeyChunker, splitKeys } from '../src/key-chunks.js'
import { PasteAssembler } from '../src/paste.js'

const keys = (s: string) => splitKeys(s).tokens

describe('splitKeys', () => {
  it('splits text from the Enter that follows it in the same chunk', () => {
    expect(keys('hi\r')).toEqual(['hi', '\r'])
    expect(keys('a\tb\x7f')).toEqual(['a', '\t', 'b', '\x7f'])
  })

  it('keeps CJK and emoji text runs whole', () => {
    expect(keys('今天👨‍👩‍👧好\r')).toEqual(['今天👨‍👩‍👧好', '\r'])
  })

  it('cuts CSI, SS3, SGR mouse, kitty and Alt keys one by one', () => {
    expect(keys('\x1b[A\x1b[1;5C\x1bOP\x1b[<35;40;12M\x1b[97;5u\x1bf\x1b\x1b[A')).toEqual([
      '\x1b[A',
      '\x1b[1;5C',
      '\x1bOP',
      '\x1b[<35;40;12M',
      '\x1b[97;5u',
      '\x1bf',
      '\x1b\x1b[A',
    ])
    expect(keys('\x1b]0;title\x07x\x1b]8;;u\x1b\\y')).toEqual([
      '\x1b]0;title\x07',
      'x',
      '\x1b]8;;u\x1b\\',
      'y',
    ])
  })

  it('reports an unfinished sequence as rest', () => {
    for (const tail of ['\x1b', '\x1b[', '\x1b[<35;4', '\x1bO', '\x1b]0;ti', '\x1b\x1b'])
      expect(splitKeys(`a${tail}`)).toEqual({ tokens: ['a'], rest: tail })
  })
})

describe('KeyChunker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const make = () => {
    const out: string[] = []
    return { out, chunker: new KeyChunker((k) => out.push(k)) }
  }

  it('joins a sequence cut between chunks (ESC | [A, and a split SGR mouse report)', () => {
    const { out, chunker } = make()
    chunker.push('\x1b')
    chunker.push('[A')
    chunker.push('\x1b[<35;4')
    chunker.push('0;12M')
    expect(out).toEqual(['\x1b[A', '\x1b[<35;40;12M'])
    vi.advanceTimersByTime(1000)
    expect(out).toHaveLength(2)
  })

  it('reads a lone Esc and the next typed key as two keys, not Alt plus the key', () => {
    const { out, chunker } = make()
    chunker.push('\x1b')
    chunker.push('j')
    chunker.push('\x1b\x1b')
    chunker.push('k')
    expect(out).toEqual(['\x1b', 'j', '\x1b', '\x1b', 'k'])
  })

  it('delivers a lone Esc once the hold time passes', () => {
    const { out, chunker } = make()
    chunker.push('\x1b')
    vi.advanceTimersByTime(KEY_HOLD_MS - 1)
    expect(out).toEqual([])
    vi.advanceTimersByTime(1)
    expect(out).toEqual(['\x1b'])
  })

  it('reads two Escs in one chunk as two presses when no sequence follows', () => {
    const { out, chunker } = make()
    chunker.push('\x1b')
    chunker.push('\x1b')
    vi.advanceTimersByTime(KEY_HOLD_MS)
    expect(out).toEqual(['\x1b', '\x1b'])
  })

  it('passes a bracketed paste whole and delivers a held Esc before it', () => {
    const { out, chunker } = make()
    const paste = '\x1b[200~a\rb\x1b[A\x1b[201~'
    chunker.push('\x1b')
    chunker.push(paste)
    expect(out).toEqual(['\x1b', paste])
  })

  it('clear drops what is held', () => {
    const { out, chunker } = make()
    chunker.push('\x1b')
    chunker.clear()
    vi.advanceTimersByTime(1000)
    expect(out).toEqual([])
  })
})

describe('PasteAssembler in front of KeyChunker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const wire = () => {
    const out: string[] = []
    const keys = new KeyChunker((k) => out.push(k))
    const feed = (parts: string[]) => {
      for (const p of parts) keys.push(p)
    }
    const idle = (parts: string[]) => {
      feed(parts)
      keys.flush()
    }
    const paste = new PasteAssembler()
    return { out, send: (d: string) => feed(paste.push(d, idle)) }
  }
  const whole = '\x1b[200~line1\rline2\x1b[201~'

  it('recognises a paste start marker cut at every position', () => {
    for (let i = 1; i < 6; i++) {
      const { out, send } = wire()
      const data = `${whole}x`
      send(data.slice(0, i))
      send(data.slice(i))
      vi.advanceTimersByTime(KEY_HOLD_MS * 3)
      expect(out, `cut at ${i}`).toEqual([whole, 'x'])
    }
  })

  it('keeps a held Esc apart from a next chunk that does not continue the marker', () => {
    const { out, send } = wire()
    send('\x1b')
    send('j')
    vi.advanceTimersByTime(KEY_HOLD_MS * 3)
    expect(out).toEqual(['\x1b', 'j'])
  })

  it('still delivers a lone Esc and a CSI key ending a chunk within one hold time', () => {
    const { out, send } = wire()
    send('a\x1b')
    vi.advanceTimersByTime(KEY_HOLD_MS)
    expect(out).toEqual(['a', '\x1b'])
    send('\x1b[20')
    vi.advanceTimersByTime(KEY_HOLD_MS)
    send('0~')
    vi.advanceTimersByTime(KEY_HOLD_MS * 3)
    expect(out.slice(2).join('')).toBe('\x1b[20' + '0~')
    expect(out).not.toContain(whole)
  })

  it('delivers a paste whose end marker never came and lets input go on', () => {
    const { out, send } = wire()
    send('\x1b[200~part one')
    vi.advanceTimersByTime(1500)
    send(' part two')
    vi.advanceTimersByTime(1500)
    expect(out).toEqual([])
    vi.advanceTimersByTime(600)
    expect(out).toEqual(['\x1b[200~part one part two\x1b[201~'])
    send('\x03')
    expect(out.slice(1)).toEqual(['\x03'])
  })

  it('keeps the rest of a stalled paste a paste, so its newlines do not submit, until a key or the end marker', () => {
    const { out, send } = wire()
    send('\x1b[200~first half')
    vi.advanceTimersByTime(2100)
    send(' second\nhalf')
    vi.advanceTimersByTime(KEY_HOLD_MS * 3)
    expect(out).toEqual(['\x1b[200~first half\x1b[201~', '\x1b[200~ second\nhalf\x1b[201~'])
    send('\x1b[201~')
    vi.advanceTimersByTime(KEY_HOLD_MS * 3)
    send('\r')
    expect(out.slice(2)).toEqual(['\r'])
    // With the end marker lost for good, the first key typed ends it.
    send('\x1b[200~again')
    vi.advanceTimersByTime(2100)
    send('\r')
    expect(out.slice(3)).toEqual(['\x1b[200~again\x1b[201~', '\r'])
  })

  it('drops a held paste on clear', () => {
    const out: string[][] = []
    const paste = new PasteAssembler()
    paste.push('\x1b[200~abc', (p) => out.push(p))
    paste.clear()
    vi.advanceTimersByTime(5000)
    expect(out).toEqual([])
    expect(paste.push('\x03')).toEqual(['\x03'])
  })
})
