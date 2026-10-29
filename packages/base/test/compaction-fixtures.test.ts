import { readFileSync } from 'node:fs'
import type { SurfaceNode } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { type Cut, chooseCut } from '../extensions/compaction/src/cut.js'
import { createDefaultCompactionEngine } from '../extensions/compaction/src/engine.js'
import { buildPrompts, IN_PROGRESS_NOTE } from '../extensions/compaction/src/prompts.js'

type Case = {
  id: string
  keepRecentTokens: number
  reason: 'threshold' | 'overflow' | 'requested'
  nodes: SurfaceNode[]
  previousSummarySeq?: number
  expect: Cut | null
}

const cases = JSON.parse(
  readFileSync(new URL('../fixtures/compaction/cases.json', import.meta.url), 'utf8'),
) as Case[]

describe('prime-agent compaction fixture parity', () => {
  it('contains exactly one named case for every Task 23 semantic class', () => {
    expect(cases.map(({ id }) => id).sort()).toEqual(
      [
        'all-fits',
        'head-summary',
        'one-turn',
        'overflow-halves',
        'pinned-retained',
        'split-turn',
        'threshold-basic',
        'trailing-tool-batch',
      ].sort(),
    )
    expect(new Set(cases.map(({ id }) => id)).size).toBe(cases.length)
  })

  for (const fixture of cases) {
    it(fixture.id, () => {
      expect(fixture.nodes.map(({ seq }) => seq)).toEqual(
        [...fixture.nodes].map(({ seq }) => seq).sort((a, b) => a - b),
      )
      const keep =
        fixture.reason === 'overflow' ? Math.floor(fixture.keepRecentTokens / 2) : fixture.keepRecentTokens
      const cut = chooseCut(fixture.nodes, keep)
      expect(cut).toEqual(fixture.expect)

      if (cut) {
        const prompts = buildPrompts({
          hasPrevious: typeof fixture.previousSummarySeq === 'number' && fixture.previousSummarySeq > 0,
          hasPrefix: cut.turnPrefixRange !== undefined,
          inProgressTail: cut.inProgressTail === true,
        })
        expect(prompts.history.includes(IN_PROGRESS_NOTE)).toBe(cut.inProgressTail === true)
        expect(prompts.history.includes('previous summary')).toBe(
          typeof fixture.previousSummarySeq === 'number' && fixture.previousSummarySeq > 0,
        )
        expect(prompts.prefix !== undefined).toBe(cut.turnPrefixRange !== undefined)
        expect(Object.values(prompts).join('\n')).not.toMatch(/\{\{(?:HISTORY|PREVIOUS_SUMMARY)\}\}/)
      }
    })
  }
})

it('preserves default threshold hysteresis, planner output and cancellation on the public engine', async () => {
  const plan: import('@agnes/extension-api').CompactionPlan = {
    keepFromSeq: 3,
    summarizeRange: [1, 2],
    prompts: { system: 'summary', history: 'summarize' },
    maxTokens: 10,
    details: { readFiles: [], modifiedFiles: [] },
  }
  const engine = await createDefaultCompactionEngine(() => plan).create()
  const budget = {
    contextTokens: 85,
    contextWindow: 100,
    reserveTokens: 20,
    keepRecentTokens: 10,
    cache: { cacheRead: 8, input: 2 },
  }
  expect(engine.shouldCompact(budget)).toBe(false)
  expect(engine.shouldCompact(budget)).toBe(true)
  expect(engine.shouldCompact({ ...budget, contextTokens: 70 })).toBe(false)
  expect(engine.shouldCompact(budget)).toBe(false)
  expect(() => engine.shouldCompact({ ...budget, reserveTokens: -1 })).toThrow(
    expect.objectContaining({ code: 'E_ENVELOPE' }),
  )
  const input = {
    conversation: [],
    system: '',
    budget,
    beforeCompact: { reason: 'requested' },
  } as unknown as import('@agnes/extension-api').CompactionInput
  const model = {
    summarize: async () => {
      throw new Error('Must not call model')
    },
  }
  // Empty input bypasses quality preparation and preserves the planner's return value.
  expect(await engine.compact(input, { signal: new AbortController().signal, model })).toEqual({
    kind: 'plan',
    plan,
  })
  const ac = new AbortController()
  ac.abort(new Error('Stopped'))
  await expect(engine.compact(input, { signal: ac.signal, model })).rejects.toThrow('Stopped')
})
