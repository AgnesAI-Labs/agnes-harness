import type { CompactionInput, CompactionNode, CompactionPlan } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { createDefaultCompactionEngine } from '../src/engine.js'
import { prepareCompaction } from '../src/prepare.js'

function node(seq: number, kind: CompactionNode['kind'], tokensEstimate: number, data: CompactionNode['data']): CompactionNode {
  return { seq, kind, turn: seq, pinned: false, tokensEstimate, data }
}

function input(conversation: CompactionNode[], keepRecentTokens: number): CompactionInput {
  return {
    conversation,
    system: '',
    budget: { contextTokens: 1, contextWindow: 8_000, reserveTokens: 1, keepRecentTokens },
    beforeCompact: {} as CompactionInput['beforeCompact'],
  }
}

const longText = 'x'.repeat(20_000)

describe('prepareCompaction', () => {
  it('elides an old oversized tool result and leaves the recent suffix', () => {
    const prepared = prepareCompaction(
      input(
        [
          node(1, 'user', 100, { content: 'hello' }),
          node(2, 'tool_result', 6000, { content: longText }),
          node(3, 'user', 100, { content: 'next' }),
        ],
        100,
      ),
    )
    expect(prepared).toMatchObject({ kind: 'replacement', range: [1, 2], mode: 'elision' })
    if (prepared?.kind !== 'replacement') return
    expect(prepared.text.length).toBeLessThan(longText.length)
    expect(prepared.text).toContain('[... tool result middle pruned ...]')
  })

  it('offloads an old image that exceeds the byte budget', () => {
    const data = 'A'.repeat(1_400_000)
    const prepared = prepareCompaction(
      input(
        [
          node(1, 'user', 100_000, { type: 'image', data, mimeType: 'image/png' }),
          node(2, 'user', 100, { content: 'next' }),
        ],
        100,
      ),
    )
    expect(prepared).toMatchObject({ kind: 'replacement', range: [1, 1], mode: 'elision' })
    if (prepared?.kind !== 'replacement') return
    expect(prepared.text).toContain('[image offloaded image/png')
    expect(prepared.text).not.toContain(data)
  })

  it('returns null when nothing was shortened', () => {
    expect(
      prepareCompaction(
        input(
          [
            node(1, 'user', 100, { content: 'hello' }),
            node(2, 'tool_result', 6000, { content: 'short' }),
            node(3, 'user', 100, { content: 'next' }),
          ],
          100,
        ),
      ),
    ).toBeNull()
    expect(
      prepareCompaction(
        input(
          [
            node(1, 'user', 100_000, { type: 'image', data: 'AAAA', mimeType: 'image/png' }),
            node(2, 'user', 100, { content: 'next' }),
          ],
          100,
        ),
      ),
    ).toBeNull()
  })
})

describe('createDefaultCompactionEngine', () => {
  it('delegates the compact trigger and falls through to the planner when nothing was shortened', async () => {
    let planned = false
    const engine = createDefaultCompactionEngine(() => {
      planned = true
      return { summarizeRange: [1, 1] } as CompactionPlan
    })
    const instance = await engine.create()
    expect(instance.shouldCompact({ contextTokens: 10, contextWindow: 100, reserveTokens: 1 })).toBe(false)
    expect(instance.shouldCompact({ contextTokens: 1000, contextWindow: 100, reserveTokens: 10 })).toBe(true)
    const output = await instance.compact(input([node(1, 'user', 10, { content: 'only' })], 100), {
      signal: new AbortController().signal,
      model: { summarize: async () => 'unused' },
    })
    expect(planned).toBe(true)
    expect(output).toMatchObject({ kind: 'plan' })
  })
})
