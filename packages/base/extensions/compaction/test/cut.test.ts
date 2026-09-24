import { describe, expect, it } from 'vitest'
import { chooseCut, estimateTokens, pairClosed } from '../src/cut.js'

const u = (seq: number, tokensEstimate = 100) => ({
  seq,
  type: 'user/message' as const,
  tokensEstimate,
})
const a = (seq: number, tokensEstimate = 100) => ({
  seq,
  type: 'assistant/message' as const,
  tokensEstimate,
})
const r = (seq: number, tokensEstimate = 100) => ({
  seq,
  type: 'tool/result' as const,
  tokensEstimate,
})
const s = (seq: number, tokensEstimate = 100) => ({
  seq,
  type: 'summary' as const,
  tokensEstimate,
})

describe('chooseCut', () => {
  it('uses an assistant boundary and emits a split-turn prefix', () => {
    // The cut lands on a8 even though a tool result precedes it: the batch closes before the cut.
    const nodes = [u(1), a(2), r(3), a(4), u(5), a(6), r(7), a(8), u(9), a(10)]
    expect(chooseCut(nodes, 250)).toEqual({
      keepFromSeq: 8,
      summarizeRange: [1, 4],
      turnPrefixRange: [5, 7],
    })
  })

  it('cuts at a user boundary without a prefix', () => {
    const nodes = [u(1), a(2), u(3), a(4), u(5), a(6)]
    expect(chooseCut(nodes, 150)).toEqual({ keepFromSeq: 5, summarizeRange: [1, 4] })
  })

  it('returns null when everything fits and retains a pinned node', () => {
    expect(chooseCut([u(1), a(2)], 1000)).toBeNull()
    const nodes = [u(1), a(2), { ...u(3), pinned: true }, a(4), u(5), a(6), u(7), a(8)]
    expect(chooseCut(nodes, 150)).toEqual({ keepFromSeq: 3, summarizeRange: [1, 2] })
  })

  it('retains an assistant with its pinned tool result', () => {
    const nodes = [u(1), a(2), u(3), a(4), { ...r(5), pinned: true }, a(6), u(7), a(8)]
    expect(chooseCut(nodes, 150)).toEqual({
      keepFromSeq: 4,
      summarizeRange: [1, 2],
      turnPrefixRange: [3, 3],
    })
  })

  it('replaces an existing summary on repeated compaction', () => {
    const nodes = [
      { seq: 1, type: 'summary' as const, tokensEstimate: 300 },
      u(2),
      a(3),
      u(4),
      a(5),
      u(6),
      a(7),
    ]
    expect(chooseCut(nodes, 150)).toEqual({ keepFromSeq: 6, summarizeRange: [1, 5] })
  })

  it('cuts at the user after a turn that ended on a tool result', () => {
    const nodes = [u(1), a(2), r(3), u(4), a(5), u(6), a(7)]
    expect(chooseCut(nodes, 350)).toEqual({ keepFromSeq: 4, summarizeRange: [1, 3] })
  })

  it('cuts inside a single long tool loop and marks the range as ending in a running turn', () => {
    const nodes = [u(1), a(2), r(3), a(4), r(5), a(6), r(7), a(8), r(9)]
    expect(chooseCut(nodes, 250)).toEqual({ keepFromSeq: 8, summarizeRange: [1, 7], inProgressTail: true })
  })

  it('splits a tool loop that follows earlier history into main range and prefix', () => {
    const nodes = [u(1), a(2), u(3), a(4), r(5), a(6), r(7), a(8), r(9)]
    expect(chooseCut(nodes, 250)).toEqual({
      keepFromSeq: 8,
      summarizeRange: [1, 2],
      turnPrefixRange: [3, 7],
    })
  })

  it('cuts a tool loop that continues after an earlier summary', () => {
    const nodes = [s(1), a(2), r(3), a(4), r(5), a(6), r(7)]
    expect(chooseCut(nodes, 150)).toEqual({ keepFromSeq: 6, summarizeRange: [1, 5], inProgressTail: true })
  })

  it('does not split out a main range that would hold only the previous summary', () => {
    const nodes = [s(1), u(2), a(3), r(4), a(5), r(6), a(7), r(8)]
    expect(chooseCut(nodes, 150)).toEqual({ keepFromSeq: 7, summarizeRange: [1, 6], inProgressTail: true })
  })

  it('keeps only the last step when the budget is crossed inside the trailing results', () => {
    expect(chooseCut([u(1), a(2), r(3), a(4), r(5, 5000)], 1000)).toEqual({
      keepFromSeq: 4,
      summarizeRange: [1, 3],
      inProgressTail: true,
    })
    // Same shape as the upstream reference's case for this rule: the cut lands on the last assistant
    // before the oversized results and the turn's opening becomes the prefix.
    expect(chooseCut([u(1), a(2), u(3), a(4), r(5, 10000), r(6, 10000)], 1000)).toEqual({
      keepFromSeq: 4,
      summarizeRange: [1, 2],
      turnPrefixRange: [3, 3],
    })
  })

  it('never cuts between the results of one parallel batch', () => {
    expect(chooseCut([u(1), a(2), r(3), r(4), a(5), r(6)], 150)).toEqual({
      keepFromSeq: 5,
      summarizeRange: [1, 4],
      inProgressTail: true,
    })
  })

  it('moves the cut back to the assistant when a runtime note separates its results', () => {
    // r3 is a2's refused result, u4 the runtime_context note, r5 a2's executed result.
    expect(chooseCut([u(1), a(2), r(3), u(4), r(5), a(6), r(7)], 350)).toEqual({
      keepFromSeq: 2,
      summarizeRange: [1, 1],
      inProgressTail: true,
    })
  })

  it('refuses a range that would hold nothing but the previous summary', () => {
    expect(chooseCut([s(1), a(2), r(3, 5000)], 1000)).toBeNull()
  })

  it('keeps a pin and still applies the trailing-results rule', () => {
    const pinnedEarly = [u(1), { ...a(2), pinned: true }, r(3), a(4), r(5, 5000)]
    expect(chooseCut(pinnedEarly, 1000)).toEqual({
      keepFromSeq: 2,
      summarizeRange: [1, 1],
      inProgressTail: true,
    })
    const pinnedLate = [u(1), a(2), r(3), u(4), a(5), { ...r(6), pinned: true }, a(7), r(8, 5000)]
    expect(chooseCut(pinnedLate, 1000)).toEqual({
      keepFromSeq: 5,
      summarizeRange: [1, 3],
      turnPrefixRange: [4, 4],
    })
  })

  it('checks candidate ranges with the same pairing rule core applies', () => {
    expect(pairClosed([u(1), a(2), r(3), a(4)], 0, 2)).toBe(true)
    expect(pairClosed([u(1), a(2), r(3), r(4), a(5)], 0, 2)).toBe(false)
    expect(pairClosed([u(1), a(2), u(3), r(4)], 0, 1)).toBe(false)
    expect(pairClosed([u(1), a(2), s(3), r(4), a(5)], 0, 1)).toBe(true)
    expect(pairClosed([s(1), r(2), a(3)], 0, 1)).toBe(true)
    expect(pairClosed([u(1), a(2), r(3), a(4)], 2, 3)).toBe(false)
  })

  it('uses the conservative fallback for invalid estimates', () => {
    expect(estimateTokens({ seq: 1, type: 'user/message' })).toBe(64)
    expect(estimateTokens({ seq: 1, type: 'user/message', tokensEstimate: Number.NaN })).toBe(64)
  })
})
