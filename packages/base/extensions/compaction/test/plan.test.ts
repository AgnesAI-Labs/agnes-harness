import { describe, expect, it } from 'vitest'
import { buildCompactionPlan } from '../src/plan.js'
import { IN_PROGRESS_NOTE } from '../src/prompts.js'

const u = (seq: number) => ({ seq, type: 'user/message' as const, tokensEstimate: 100 })
const a = (seq: number) => ({ seq, type: 'assistant/message' as const, tokensEstimate: 100 })
const nodes = [u(1), a(2), u(3), a(4), u(5), a(6), u(7), a(8)]
const base = {
  contextTokens: 9000,
  contextWindow: 10000,
  reserveTokens: 16384,
  reason: 'threshold' as const,
  getSurface: () => nodes,
}

describe('buildCompactionPlan', () => {
  it('assembles the current cut semantics, prompts, details, and optional context', () => {
    const plan = buildCompactionPlan(
      {
        ...base,
        previousSummarySeq: 2,
        customInstructions: 'retain exact commands',
        toolCalls: [{ name: 'edit', args: { path: 'x.ts' } }],
        kernelNote: 'df: 3 rows',
      },
      { keepRecentTokens: 250 },
    )
    expect(plan).toMatchObject({
      keepFromSeq: 6,
      summarizeRange: [1, 4],
      turnPrefixRange: [5, 5],
      previousSummarySeq: 2,
      maxTokens: 13107, // floor(0.8 * 16384), not the old flat 2048 constant
      details: { readFiles: [], modifiedFiles: ['x.ts'] },
      customInstructions: 'retain exact commands',
    })
    expect(plan?.prompts.history).toContain('previous summary')
    expect(plan?.prompts.history).not.toMatch(/\{\{(?:HISTORY|PREVIOUS_SUMMARY)\}\}/)
    expect(plan?.prompts.prefix).toContain('turn continues below')
    expect(plan?.prompts.system).toContain('Runtime state to preserve in Critical context:\ndf: 3 rows')
  })

  it('scales maxTokens with reserveTokens instead of using a fixed constant', () => {
    const wide = buildCompactionPlan({ ...base, reserveTokens: 16384 }, { keepRecentTokens: 250 })
    const narrow = buildCompactionPlan({ ...base, reserveTokens: 1000 }, { keepRecentTokens: 250 })
    expect(wide?.maxTokens).toBe(13107)
    expect(narrow?.maxTokens).toBe(800) // floor(0.8 * 1000)
  })

  it('returns null when nothing can be summarized', () => {
    expect(
      buildCompactionPlan({ ...base, getSurface: () => [u(1), a(2)] }, { keepRecentTokens: 1000 }),
    ).toBeNull()
  })

  it('halves the retained window only for overflow', () => {
    const threshold = buildCompactionPlan(base, { keepRecentTokens: 500 })
    const overflow = buildCompactionPlan({ ...base, reason: 'overflow' }, { keepRecentTokens: 500 })
    expect(threshold?.keepFromSeq).toBe(4)
    expect(overflow?.keepFromSeq).toBe(6)
  })

  it('asks the single-range summary of a running turn to record its request', () => {
    const r = (seq: number) => ({ seq, type: 'tool/result' as const, tokensEstimate: 100 })
    const loop = [u(1), a(2), r(3), a(4), r(5), a(6), r(7)]
    const plan = buildCompactionPlan({ ...base, getSurface: () => loop }, { keepRecentTokens: 150 })
    expect(plan).toMatchObject({ keepFromSeq: 6, summarizeRange: [1, 5] })
    expect(plan).not.toHaveProperty('turnPrefixRange')
    expect(plan).not.toHaveProperty('inProgressTail')
    expect(plan?.prompts.history).toContain(IN_PROGRESS_NOTE)
    expect(plan?.prompts.prefix).toBeUndefined()
  })

  it('treats a non-positive previous summary sequence as absent', () => {
    const plan = buildCompactionPlan({ ...base, previousSummarySeq: 0 }, { keepRecentTokens: 250 })
    expect(plan).not.toHaveProperty('previousSummarySeq')
    expect(plan?.prompts.history).not.toContain('{{PREVIOUS_SUMMARY}}')
  })
})
