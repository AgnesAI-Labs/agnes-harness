import { type SurfaceNode as CoreNode, computeSurface, validateReplace } from '@agnes/core'
import type { SurfaceNode as HookNode } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { chooseCut, pairClosed } from '../extensions/compaction/src/cut.js'

/**
 * The default planner mirrors core's replace pairing rule on the reduced hook view. If the two ever
 * disagree, the planner proposes cuts core refuses, and an overflow compaction ends the turn instead
 * of compacting. Surfaces are generated along core's real write paths and compared range by range.
 */

const SEEDS = 600

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
type Event = CoreNode['event']

function coreAccepts(surface: readonly CoreNode[], i: number, j: number): boolean {
  const seqs = surface.slice(i, j + 1).map((n) => n.seq)
  try {
    validateReplace({ start: seqs[0] as number, end: seqs.at(-1) as number }, seqs, surface, new Map())
    return true
  } catch {
    return false
  }
}

function generate(seed: number): { surface: CoreNode[]; rand: () => number } {
  const rand = mulberry32(seed)
  const pick = (n: number) => Math.floor(rand() * n)
  const events: Event[] = []
  let seq = 0
  const push = (type: string, data: unknown, extra: Partial<Event> = {}) => {
    events.push({
      seq: ++seq,
      ts: '2026-01-01T00:00:00.000Z',
      id: `ev${seq}`,
      type,
      data,
      actor,
      origin: 'principal',
      trust: 'trusted',
      lane: 'main',
      v: 1,
      ...extra,
    } as Event)
  }
  const user = (origin = 'principal') =>
    push('user/message', { content: [{ type: 'text', text: 'u' }] }, { origin } as Partial<Event>)
  const assistant = () => push('assistant/message', { content: [], stopReason: 'end_turn' })
  const result = () => push('tool/result', { toolUseId: `t${seq}`, content: [], isError: false })
  const turn = () => {
    user()
    const steps = 1 + pick(5)
    for (let step = 0; step < steps; step++) {
      if (step > 0 && rand() < 0.2) user()
      assistant()
      const calls = pick(4)
      if (calls === 0) return
      const refused = Array.from({ length: calls }, () => rand() < 0.3).filter(Boolean).length
      for (let k = 0; k < refused; k++) result()
      if (refused > 0 && refused < calls && rand() < 0.3) user('system')
      for (let k = refused; k < calls; k++) result()
      if (step === steps - 1 && rand() < 0.3) return
    }
    assistant()
  }
  turn()
  turn()
  if (rand() < 0.6) {
    const surface = computeSurface(events, {})
    const candidates: Array<[number, number]> = []
    for (let i = 0; i < surface.length - 1; i++)
      for (let j = i; j < surface.length - 1; j++)
        if (rand() < 0.5 ? coreAccepts(surface, i, j) : surface[i]?.kind !== 'tool_result')
          candidates.push([i, j])
    const chosen = candidates[pick(candidates.length)]
    if (chosen) {
      const seqs = surface.slice(chosen[0], chosen[1] + 1).map((n) => n.seq)
      push('assistant/message', { content: [{ type: 'text', text: 's' }], stopReason: 'end_turn' }, {
        surfaceOp: { op: 'replace', start: seqs[0], end: seqs.at(-1) },
        sourceEventSeqs: seqs,
      } as Partial<Event>)
    }
    turn()
  }
  // A pin on some node, as compaction or the model would place one before a range is chosen.
  const pins = new Set<number>()
  const plain = computeSurface(events, {})
  if (rand() < 0.4) pins.add(plain[pick(plain.length)]?.seq as number)
  return { surface: computeSurface(events, { pins }), rand }
}

const HOOK_TYPE: Record<CoreNode['kind'], HookNode['type']> = {
  summary: 'summary',
  tool_result: 'tool/result',
  assistant: 'assistant/message',
  user: 'user/message',
}

describe('base and core agree on replace pairing', () => {
  it(`on every range and every default cut across ${SEEDS} generated surfaces`, () => {
    let ranges = 0
    let cuts = 0
    let splits = 0
    let tails = 0
    let pinned = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { surface, rand } = generate(seed)
      const hook: HookNode[] = surface.map((n) => ({
        seq: n.seq,
        type: HOOK_TYPE[n.kind],
        ...(n.pinned ? { pinned: true } : {}),
        tokensEstimate: 50 + Math.floor(rand() * 450),
      }))
      if (hook.some((n) => n.pinned)) pinned++
      for (let i = 0; i < surface.length; i++)
        for (let j = i; j < surface.length; j++) {
          ranges++
          // Core refuses a pinned range on top of the pairing rule; base keeps pins out of its cuts.
          const base = pairClosed(hook, i, j) && !hook.slice(i, j + 1).some((n) => n.pinned)
          if (base !== coreAccepts(surface, i, j))
            expect.fail(`seed ${seed} [${i}..${j}] ${hook.map((n) => n.type[0]).join('')}`)
        }
      for (const keep of [100, 400, 1000, 3000]) {
        const cut = chooseCut(hook, keep)
        if (!cut) continue
        cuts++
        const index = (seq: number) => surface.findIndex((n) => n.seq === seq)
        const from = index(cut.summarizeRange[0])
        const to = index(cut.summarizeRange[1])
        const spanTo = cut.turnPrefixRange ? index(cut.turnPrefixRange[1]) : to
        const where = `seed ${seed} keep ${keep} ${JSON.stringify(cut)}`
        if (!coreAccepts(surface, from, spanTo)) expect.fail(`span ${where}`)
        if (!coreAccepts(surface, from, to)) expect.fail(`main ${where}`)
        if (cut.turnPrefixRange) {
          splits++
          if (index(cut.turnPrefixRange[0]) !== to + 1) expect.fail(`prefix gap ${where}`)
          if (!coreAccepts(surface, to + 1, spanTo)) expect.fail(`prefix ${where}`)
        }
        if (cut.inProgressTail) tails++
        if (index(cut.keepFromSeq) !== spanTo + 1) expect.fail(`kept ${where}`)
      }
    }
    expect(cuts).toBeGreaterThan(0)
    expect(splits).toBeGreaterThan(0)
    expect(tails).toBeGreaterThan(0)
    expect(pinned).toBeGreaterThan(0)
    console.info('pairing parity', JSON.stringify({ ranges, cuts, splits, tails, pinned }))
  }, 60_000)
})
