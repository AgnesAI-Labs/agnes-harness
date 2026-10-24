import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEY_HOLD_MS, KeyChunker, splitKeys } from '../src/key-chunks.js'

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
