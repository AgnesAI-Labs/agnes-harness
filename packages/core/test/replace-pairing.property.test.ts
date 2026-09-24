import type { RequestBody } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { computeSurface, type SurfaceNode, validateReplace } from '../src/project/surface.js'
import { deriveRequest } from '../src/request/derive.js'
import { createEnvelopeCache } from '../src/request/envelope-cache.js'
import { toProviderRequest } from '../src/request/to-provider.js'
import type { Event, Seq } from '../src/types.js'

/**
 * Property test for the replace pairing rule. Ledgers are generated along the write paths core
 * actually has (plain tool batches, refused-then-executed results, the unparsed runtime_context
 * note, steer notes at checkpoints, turns ending on results or on a call still waiting for its
 * result, earlier compactions at the head or mid-surface, pins), with each result's real owner
 * recorded by the generator, and every contiguous range of the folded surface is judged against that
 * ground truth. For a sample of accepted ranges the actual main and summary requests are minted and
 * checked on the wire.
 */

const SEEDS = 2000
const MAX_NODES = 40

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

/** The baseline boundary rule, kept only here as the comparison the new rule must not regress from. */
function legacyBoundaryRule(op: { start: Seq; end: Seq }, events: Map<Seq, Event>): boolean {
  for (const boundary of [op.start, op.end]) if (events.get(boundary)?.type === 'tool/result') return false
  return true
}

type EarlierMode = 'none' | 'new' | 'mid' | 'old' | 'any'

type Call = { assistantSeq: Seq; toolUseId: string; name: string; args: unknown; ordinal: number }

type Generated = {
  events: Event[]
  /** Real owner of every tool/result row, by the generator's own bookkeeping. */
  owner: Map<Seq, Seq>
  /** Every call the model made, answered or not, as the ledger's tool/call rows would list them. */
  calls: Call[]
  /** Calls no result row ever answered. */
  unanswered: Set<string>
  pins: Set<Seq>
  mode: EarlierMode
}

function newAccepts(surface: readonly SurfaceNode[], i: number, j: number, events: Map<Seq, Event>): boolean {
  const start = surface[i]?.seq as Seq
  const end = surface[j]?.seq as Seq
  try {
    validateReplace(
      { start, end },
      surface.slice(i, j + 1).map((n) => n.seq),
      surface,
      events,
    )
    return true
  } catch {
    return false
  }
}

function generate(seed: number): Generated {
  const rand = mulberry32(seed)
  const pick = (n: number) => Math.floor(rand() * n)
  const events: Event[] = []
  const owner = new Map<Seq, Seq>()
  const calls: Call[] = []
  const unanswered = new Set<string>()
  let seq = 0
  let ids = 0
  const push = (type: string, data: unknown, extra: Partial<Event> = {}): Event => {
    const e = {
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
    } as Event
    events.push(e)
    return e
  }
  const user = (extra: Partial<Event> = {}) =>
    push('user/message', { content: [{ type: 'text', text: 'u' }] }, extra)
  const note = () => user({ origin: 'system' })
  const assistant = () =>
    push('assistant/message', { content: [{ type: 'text', text: 'a' }], stopReason: 'end_turn' }).seq
  const call = (of: Seq) => {
    const toolUseId = `t${++ids}`
    calls.push({ assistantSeq: of, toolUseId, name: 'read', args: { path: toolUseId }, ordinal: ids })
    return toolUseId
  }
  const result = (of: Seq) => {
    const r = push('tool/result', { toolUseId: call(of), content: [], isError: false })
    owner.set(r.seq, of)
  }
  const nodes = () => computeSurface(events, {}).length
  const turn = () => {
    user({ trust: rand() < 0.3 ? 'untrusted' : 'trusted' })
    const steps = 1 + pick(4)
    for (let step = 0; step < steps && nodes() < MAX_NODES; step++) {
      // A steer the principal sent while the previous batch ran, accepted at the checkpoint.
      if (step > 0 && rand() < 0.2) user()
      const a = assistant()
      const calls = pick(4)
      if (calls === 0) {
        // StopGate's keep-going note, answered by another assistant message.
        if (rand() < 0.2) {
          note()
          assistant()
        }
        return
      }
      const refused = Array.from({ length: calls }, () => rand() < 0.3).filter(Boolean).length
      const executed = calls - refused
      for (let k = 0; k < refused; k++) result(a)
      if (refused > 0 && executed > 0 && rand() < 0.3) note()
      for (let k = 0; k < executed; k++) result(a)
      // A call parked for approval: the turn ends before its result exists.
      if (step === steps - 1 && rand() < 0.15) {
        unanswered.add(call(a))
        return
      }
      // A tool that asked to end the turn closes it on its results.
      if (step === steps - 1 && rand() < 0.3) return
    }
    assistant()
  }

  const modes: EarlierMode[] = ['none', 'new', 'mid', 'old', 'any']
  const mode = modes[pick(modes.length)] as EarlierMode
  turn()
  if (nodes() < MAX_NODES / 2) turn()
  if (mode !== 'none') {
    const surface = computeSurface(events, {})
    const byId = new Map(events.map((e) => [e.seq, e]))
    const candidates: Array<[number, number]> = []
    for (let i = 0; i < surface.length - 1; i++)
      for (let j = i; j < surface.length - 1; j++) {
        const op = { start: surface[i]?.seq as Seq, end: surface[j]?.seq as Seq }
        const ok =
          mode === 'new'
            ? newAccepts(surface, i, j, byId)
            : mode === 'mid'
              ? i > 0 && newAccepts(surface, i, j, byId)
              : mode === 'old'
                ? legacyBoundaryRule(op, byId)
                : surface[i]?.kind !== 'tool_result' && surface[j]?.kind !== 'tool_result'
        if (ok) candidates.push([i, j])
      }
    const chosen = candidates[pick(candidates.length)]
    if (chosen) {
      const [i, j] = chosen
      const seqs = surface.slice(i, j + 1).map((n) => n.seq)
      push(
        'assistant/message',
        { content: [{ type: 'text', text: 'summary' }], stopReason: 'end_turn' },
        {
          surfaceOp: { op: 'replace', start: seqs[0] as Seq, end: seqs.at(-1) as Seq },
          sourceEventSeqs: seqs,
        },
      )
    }
    if (nodes() < MAX_NODES) turn()
  }
  const final = computeSurface(events, {})
  const pins = new Set<Seq>()
  if (rand() < 0.3) pins.add(final[pick(final.length)]?.seq as Seq)
  return { events, owner, calls, unanswered, pins, mode }
}

/**
 * On a minted request: tool results with no call before them (looking back past results and user
 * lines to the nearest assistant), and calls not answered before the next assistant message.
 */
function wirePairing(req: RequestBody): { orphans: Set<string>; open: Set<string> } {
  const orphans = new Set<string>()
  const open = new Set<string>()
  const messages = req.messages as Array<{
    role: string
    toolUseId?: string
    toolCalls?: Array<{ toolUseId: string }>
  }>
  messages.forEach((m, i) => {
    if (m.role === 'tool_result') {
      let k = i - 1
      while (k >= 0 && (messages[k]?.role === 'tool_result' || messages[k]?.role === 'user')) k--
      if (!messages[k]?.toolCalls?.some((c) => c.toolUseId === m.toolUseId)) orphans.add(String(m.toolUseId))
    }
    for (const c of m.toolCalls ?? []) {
      let answered = false
      for (let k = i + 1; k < messages.length && messages[k]?.role !== 'assistant'; k++)
        if (messages[k]?.toolUseId === c.toolUseId) answered = true
      if (!answered) open.add(c.toolUseId)
    }
  })
  return { orphans, open }
}

const NONCE = '0123456789abcdef0123456789abcdef'

function mint(
  kind: 'turn' | 'summary',
  surface: readonly SurfaceNode[],
  calls: readonly Call[],
): RequestBody {
  const derived = deriveRequest({
    kind,
    merged: { tools: [], sections: [], runtimeContext: {}, conflicts: [] },
    harnessEntries: [],
    surface,
    disclosed: [],
    toolCalls: calls,
    model: { slot: kind === 'turn' ? 'primary' : 'compaction', route: 'default', model: 'm' },
    contract: { contract_id: null, parser_version: '1' },
    nonce: NONCE,
    envelopeCache: createEnvelopeCache(),
    ...(kind === 'summary' ? { summaryPlan: { system: 'S', instruction: 'summarize' } } : {}),
  })
  return toProviderRequest(derived.request, { sessionKey: 'k', derivedHash: derived.header.derived_hash })
}

const subset = <T>(a: Set<T>, b: Set<T>) => [...a].every((x) => b.has(x))

/** The owner by position: back from the result past results and users, stopping at a summary. */
function positionalOwner(surface: readonly SurfaceNode[], k: number): Seq | undefined {
  for (let m = k - 1; m >= 0; m--) {
    const kind = surface[m]?.kind
    if (kind === 'assistant') return surface[m]?.seq
    if (kind === 'summary') return undefined
  }
  return undefined
}

/**
 * Results whose request pairing is broken: the real call is gone (an orphan), or it is visible but
 * the result no longer sits in its batch (a mispairing, which a provider rejects the same way).
 */
function broken(surface: readonly SurfaceNode[], owner: Map<Seq, Seq>): Set<Seq> {
  const visible = new Set(surface.filter((n) => n.kind === 'assistant').map((n) => n.seq))
  const out = new Set<Seq>()
  surface.forEach((n, k) => {
    if (n.kind !== 'tool_result') return
    const real = owner.get(n.seq)
    if (real === undefined || !visible.has(real) || positionalOwner(surface, k) !== real) out.add(n.seq)
  })
  return out
}

function masked(surface: readonly SurfaceNode[], i: number, j: number): SurfaceNode[] {
  const summary = { ...(surface[i] as SurfaceNode), seq: 1_000_000, kind: 'summary' as const }
  return [...surface.slice(0, i), summary, ...surface.slice(j + 1)]
}

describe('replace pairing property', () => {
  it(`holds on ${SEEDS} generated ledgers`, () => {
    const counts = {
      ranges: 0,
      newAccepted: 0,
      oldAccepted: 0,
      oldOnlyUnsafe: 0,
      oldOnlyPreexistingOrphanNext: 0,
      newOnly: 0,
      withBroken: 0,
      pinnedRefusals: 0,
      requestsChecked: 0,
    }
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { events, owner, calls, unanswered, pins, mode } = generate(seed)
      const surface = computeSurface(events, { pins })
      const byId = new Map(events.map((e) => [e.seq, e]))
      const before = broken(surface, owner)
      if (before.size > 0) counts.withBroken++
      // (d) On surfaces the current write paths produce, the position names the real owner.
      if (mode === 'none' || mode === 'new' || mode === 'mid')
        expect(before, `seed ${seed}: position disagrees`).toEqual(new Set())
      const wireBefore = wirePairing(mint('turn', surface, calls))
      const acceptedRanges: Array<[number, number]> = []
      const visible = new Set(surface.filter((n) => n.kind === 'assistant').map((n) => n.seq))
      for (let i = 0; i < surface.length; i++)
        for (let j = i; j < surface.length; j++) {
          counts.ranges++
          const start = surface[i]?.seq as Seq
          const end = surface[j]?.seq as Seq
          const accepted = newAccepts(surface, i, j, byId)
          const legacy = legacyBoundaryRule({ start, end }, byId)
          const after = broken(masked(surface, i, j), owner)
          const inRange = new Set(surface.slice(i, j + 1).map((n) => n.seq))
          const newCallOrphans = surface
            .slice(i, j + 1)
            .filter((n) => n.kind === 'tool_result' && !before.has(n.seq))
            .filter((n) => {
              const real = owner.get(n.seq) as Seq
              return visible.has(real) && !inRange.has(real)
            })
          const nextIsResult = surface[j + 1]?.kind === 'tool_result'
          const noNewBroken = [...after].every((s) => before.has(s))
          const pinnedInRange = surface.slice(i, j + 1).some((n) => n.pinned)
          const safe = noNewBroken && newCallOrphans.length === 0 && !nextIsResult && !pinnedInRange
          const where = () =>
            `seed ${seed} range [${start}..${end}] kinds ${surface.map((n) => n.kind[0]).join('')}`
          if (accepted) {
            counts.newAccepted++
            acceptedRanges.push([i, j])
          }
          if (legacy) counts.oldAccepted++
          // (a) Soundness: whatever the new rule accepts leaves no new broken pairing behind.
          if (accepted && !safe) expect.fail(`(a) ${where()}`)
          // (b) No regression: a safe range the old rule accepted is still accepted.
          if (legacy && safe && !accepted) expect.fail(`(b) ${where()}`)
          // Completeness on clean surfaces: every safe range that does not start on a result passes.
          if (before.size === 0 && safe && surface[i]?.kind !== 'tool_result' && !accepted)
            expect.fail(`(e) ${where()}`)
          // (c) Old-accepted, new-rejected ranges are unsafe, or stop just before a result that was
          // already an orphan.
          if (legacy && !accepted) {
            if (pinnedInRange) counts.pinnedRefusals++
            else if (!noNewBroken || newCallOrphans.length > 0) counts.oldOnlyUnsafe++
            else {
              const next = surface[j + 1]
              if (next?.kind !== 'tool_result' || !before.has(next.seq)) expect.fail(`(c) ${where()}`)
              counts.oldOnlyPreexistingOrphanNext++
            }
          }
          if (accepted && !legacy) counts.newOnly++
        }
      // (f) On the wire: for a sample of accepted ranges, fold the real replace row, mint the next main
      // request and the summary request for the range, and require that neither leaves a result
      // without its call or a call without its result that was not already so.
      const sample = mulberry32(seed + 1_000_003)
      for (let n = 0; n < Math.min(4, acceptedRanges.length); n++) {
        const [i, j] = acceptedRanges[Math.floor(sample() * acceptedRanges.length)] as [number, number]
        const seqs = surface.slice(i, j + 1).map((node) => node.seq)
        const replace = {
          ...(events.at(-1) as Event),
          seq: (events.at(-1)?.seq as Seq) + 1,
          id: 'replace',
          type: 'assistant/message',
          data: { content: [{ type: 'text', text: 'summary' }], stopReason: 'end_turn' },
          surfaceOp: { op: 'replace', start: seqs[0] as Seq, end: seqs.at(-1) as Seq },
          sourceEventSeqs: seqs,
        } as Event
        const where = `seed ${seed} range [${seqs[0]}..${seqs.at(-1)}]`
        const main = wirePairing(mint('turn', computeSurface([...events, replace], { pins }), calls))
        if (!subset(main.orphans, wireBefore.orphans)) expect.fail(`(f) main orphans ${where}`)
        if (!subset(main.open, wireBefore.open)) expect.fail(`(f) main open calls ${where}`)
        const summary = wirePairing(mint('summary', surface.slice(i, j + 1), calls))
        if (!subset(summary.orphans, wireBefore.orphans)) expect.fail(`(f) summary orphans ${where}`)
        if (![...summary.open].every((id) => unanswered.has(id) || wireBefore.open.has(id)))
          expect.fail(`(f) summary open calls ${where}`)
        counts.requestsChecked += 2
      }
    }
    // The generator has to reach every class the rules disagree on, or the properties are vacuous.
    expect(counts.oldOnlyUnsafe).toBeGreaterThan(0)
    expect(counts.oldOnlyPreexistingOrphanNext).toBeGreaterThan(0)
    expect(counts.newOnly).toBeGreaterThan(0)
    expect(counts.withBroken).toBeGreaterThan(0)
    expect(counts.pinnedRefusals).toBeGreaterThan(0)
    expect(counts.requestsChecked).toBeGreaterThan(0)
    console.info('replace pairing property counts', JSON.stringify(counts))
  }, 60_000)
})
