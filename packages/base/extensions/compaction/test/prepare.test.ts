import type { CompactionInput, CompactionNode, CompactionPlan } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { createDefaultCompactionEngine } from '../src/engine.js'
import { prepareCompaction } from '../src/prepare.js'

function node(
  seq: number,
  kind: CompactionNode['kind'],
  tokensEstimate: number,
  data: CompactionNode['data'],
): CompactionNode {
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

describe('prepareCompaction and delivered experience notes', () => {
  const note = (seq: number, header: string, body: string) =>
    node(seq, 'user', 300, {
      kind: 'runtime_context',
      content: [
        { type: 'text', text: header },
        { type: 'text', text: body },
      ],
    })
  const lesson = 'Always run the formatter first, quoted lesson text'
  const long = node(3, 'tool_result', 6000, { content: longText })
  const tail = node(4, 'user', 100, { content: 'next' })

  it('writes a placeholder for a task-experience note, never its text', () => {
    const prepared = prepareCompaction(
      input(
        [
          note(1, '[task-experience]\nTask experience update, format 1.', `- [memory/a v1] A: ${lesson}`),
          long,
          tail,
        ],
        100,
      ),
    )
    expect(prepared).toMatchObject({ kind: 'replacement', mode: 'elision' })
    if (prepared?.kind !== 'replacement') return
    expect(prepared.text).not.toContain(lesson)
    expect(prepared.text).not.toContain('Task experience update')
    expect(prepared.text).toContain('[task experience note omitted]')
  })

  it('keeps every nested-result note as written, whatever tool it names', () => {
    const rejected =
      '[nested result]\nThe user rejected the nested call harness_propose inside run_code; it did not run. Do not retry it without asking.'
    const ran =
      '[nested result]\nThe nested call harness_inspect inside run_code ran after approval (status: ok). Do not run it again. Preview:'
    const prepared = prepareCompaction(
      input([note(1, rejected, 'preview'), note(2, ran, 'preview text'), long, tail], 100),
    )
    if (prepared?.kind !== 'replacement') throw new Error('expected a replacement')
    expect(prepared.text).toContain(rejected)
    expect(prepared.text).toContain(ran)
    expect(prepared.text).not.toContain('omitted]')
  })

  it('does not start an elision for a range whose only large node is a task-experience note', () => {
    const big = note(1, '[task-experience]\nTask experience snapshot, format 1.', 'entry '.repeat(5000))
    expect(prepareCompaction(input([big, node(2, 'user', 100, { content: 'hi' }), tail], 100))).toBeNull()
  })

  it('leaves the input without such notes exactly as it was', () => {
    const plain = [
      node(1, 'user', 100, { content: 'hello' }),
      node(2, 'user', 100, {
        kind: 'runtime_context',
        content: [{ type: 'text', text: '[hook context]\nCurrent time' }],
      }),
      node(3, 'user', 100, {
        content: [{ type: 'text', text: 'a [nested result]\nThe nested call read inside x. Preview:' }],
      }),
      node(5, 'tool_result', 6000, { content: longText }),
      tail,
    ]
    const prepared = prepareCompaction(input(plain, 100))
    if (prepared?.kind !== 'replacement') throw new Error('expected a replacement')
    expect(prepared.text).toContain('hello')
    expect(prepared.text).toContain('[hook context]\nCurrent time')
    expect(prepared.text).toContain('The nested call read inside x. Preview:')
    // A nested note about another tool is the harness's own words and stays as they were.
    expect(prepared.text).not.toContain('omitted]')
  })
})
