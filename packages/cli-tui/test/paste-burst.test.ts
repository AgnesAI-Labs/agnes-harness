import { describe, expect, it } from 'vitest'
import { PasteAssembler } from '../src/paste.js'

const wrap = (s: string) => `\x1b[200~${s}\x1b[201~`
const clocked = (t: { now: number }) => new PasteAssembler(true, () => t.now)

describe('paste bursts on a terminal without bracketed paste', () => {
  it('keeps the newlines of a burst, and submits again once it has been quiet', () => {
    const t = { now: 1000 }
    const paste = clocked(t)
    expect(paste.push('first line of a paste\rsecond line')).toEqual([
      wrap('first line of a paste\rsecond line'),
    ])
    t.now += 5
    expect(paste.push('\r')).toEqual([wrap('\r')])
    t.now += 25
    expect(paste.push('\r')).toEqual([wrap('\r')])
    t.now += 31
    expect(paste.push('\r')).toEqual(['\r'])
  })

  it('adds up chunks that follow each other closely, and leaves normal typing alone', () => {
    const t = { now: 0 }
    const slow = clocked(t)
    for (const c of 'a long enough sentence to type\r') {
      t.now += 80
      expect(slow.push(c)).toEqual([c])
    }
    const fast = clocked(t)
    expect(['0123456789', 'abcdefgh', '\r'].flatMap((c) => fast.push(c))).toEqual([
      '0123456789',
      'abcdefgh',
      wrap('\r'),
    ])
    expect(clocked(t).push('short\r')).toEqual(['short\r'])
  })

  it('is off for the rest of the session once a bracketed paste has been seen', () => {
    const paste = clocked({ now: 0 })
    expect(paste.push(wrap('x'))).toEqual([wrap('x')])
    expect(paste.push('a line that is long enough\r')).toEqual(['a line that is long enough\r'])
  })

  it('leaves escape sequences alone', () => {
    const keys = '\x1b[A\x1b[B\x1b[A\x1b[B\x1b[A\x1b[B\r'
    expect(clocked({ now: 0 }).push(keys)).toEqual([keys])
  })
})
