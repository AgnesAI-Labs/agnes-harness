import { readFileSync } from 'node:fs'
import type { SurfaceNode } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { type Cut, chooseCut } from '../extensions/compaction/src/cut.js'
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
