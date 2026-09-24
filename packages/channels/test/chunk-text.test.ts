import { describe, expect, it } from 'vitest'
import { chunkText, TokenBucket } from '../src/runner/throttle.js'

describe('chunkText', () => {
  it('prefers paragraph, then line, then exact hard boundaries without losing content', () => {
    for (const [text, max] of [
      ['aaa\n\nbbb\n\nccc', 8],
      ['l1\nl2\nl3', 5],
      ['x'.repeat(12), 5],
      ['\n\nleading and trailing\n\n', 7],
      ['🙂🙂🙂', 3],
    ] as const) {
      const chunks = chunkText(text, max)
      expect(chunks.every((chunk) => chunk.length <= max)).toBe(true)
      expect(chunks.join('')).toBe(text)
    }
  })

  it('keeps short and empty text as one complete piece and rejects invalid limits', () => {
    expect(chunkText('short', 100)).toEqual(['short'])
    expect(chunkText('', 5)).toEqual([''])
    expect(() => chunkText('x', 0)).toThrow(RangeError)
    expect(() => chunkText('x', 1.5)).toThrow(RangeError)
  })
})

describe('TokenBucket', () => {
  it('admits its burst and then paces queued callers in FIFO order', async () => {
    let now = 0
    const sleeps: number[] = []
    const bucket = new TokenBucket({
      tokensPerSecond: 10,
      capacity: 2,
      now: () => now,
      sleep: async (delayMs) => {
        sleeps.push(delayMs)
        now += delayMs
      },
    })
    const order: number[] = []

    await Promise.all(
      [1, 2, 3, 4].map(async (value) => {
        await bucket.take()
        order.push(value)
      }),
    )

    expect(order).toEqual([1, 2, 3, 4])
    expect(sleeps).toEqual([100, 100])
  })

  it('rejects non-positive rates and capacities', () => {
    expect(() => new TokenBucket({ tokensPerSecond: 0, capacity: 1 })).toThrow(RangeError)
    expect(() => new TokenBucket({ tokensPerSecond: 1, capacity: 0 })).toThrow(RangeError)
  })
})
