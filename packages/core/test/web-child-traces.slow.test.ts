import type { Provider, UISpan, UITurn } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { type ChildTrace, embedChildTraces, TRACE_SUBTREE_BUDGET } from '../src/project/child-trace-cache.js'
import { subagentOwners } from '../src/project/trace.js'
import { type CoreUIProjectionUpdate, markIncomplete } from '../src/project/ui.js'
import type { SessionImpl } from '../src/step/session.js'
import type { Seq } from '../src/types.js'
import {
  answerThenHang,
  cancel,
  childRows,
  closeKernels,
  row,
  scripted,
  setupWith,
  slowCommits,
  spawnChild,
  spawnTurn,
  subagentSpan,
  until,
  walk,
} from './helpers/child-traces.js'

const setup = (provider: Provider) => setupWith(provider, (options) => Kernel.create(options))
/** Same, with room for many children of one parent. */
const setupWide = (provider: Provider) =>
  setupWith(provider, (options) =>
    Kernel.create({ ...options, preset: { ...options.preset, maxFanOut: 64 } as typeof options.preset }),
  )

afterEach(async () => {
  vi.restoreAllMocks()
  await closeKernels()
})

const MiB = 1024 * 1024
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const upserted = (update: CoreUIProjectionUpdate): UITurn[] => {
  if (update.kind !== 'patch') throw new Error(`expected a live patch, got ${update.kind}`)
  const ids = update.patch.turnChanges.map((change) => (change.op === 'remove' ? change.id : change.turn.id))
  expect(new Set(ids).size).toBe(ids.length)
  const indexes = update.patch.turnChanges.flatMap((change) => (change.op === 'upsert' ? [change.index] : []))
  expect(indexes).toEqual([...indexes].sort((a, b) => a - b))
  return update.patch.turnChanges.flatMap((change) => (change.op === 'upsert' ? [change.turn] : []))
}
/** A title call billed to a closed turn: a parent event that changes only that turn. */
const titleCost = (turn: number, n: number) =>
  row('cost/ledger', {
    purpose: 'title',
    effectId: `title-${turn}-${n}`,
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    creditSource: 'estimated',
    model: 'title-model',
    sourceTurn: turn,
  })
const note = (text: string) => row('user/message', { content: [{ type: 'text', text }] })
const uptoOf = (update: CoreUIProjectionUpdate) => {
  if (update.kind !== 'patch') throw new Error('expected a live patch')
  return update.patch.upto
}
const byId = (turns: readonly UITurn[], id: string) => turns.find((turn) => turn.id === id)
const truncations = (span: UISpan | undefined) =>
  (span ? walk(span) : []).filter((item) => item.error?.code === 'TRACE_TRUNCATED')
/** Bytes the embedded child trees add to one turn: every owner's children minus the empty array. */
const embeddedBytes = (turn: UITurn | undefined) =>
  (turn?.trace ? walk(turn.trace) : [])
    .filter((span) => span.kind === 'subagent' && span.childSessionKey && span.children.length > 0)
    .reduce((sum, span) => sum + bytes(span.children) - 2, 0)

/** One child that answered and one still streaming, spawned from turn 1; turn 2 spawns the first again. */
async function twoChildren() {
  const { storage, k, parent } = await setup(answerThenHang())
  const done = await spawnChild(parent, 'first')
  await done.run('first')
  const live = await spawnChild(parent, 'second')
  const slow = slowCommits(storage, () => live.key)
  const running = live.run('second').catch((error: unknown) => error)
  expect(
    await until(async () => (await childRows(storage, live.key)).some((e) => e.type === 'assistant/output')),
  ).toBe(true)
  await parent.d.log.append(spawnTurn(1, [done.key, live.key]))
  await parent.d.log.append(spawnTurn(2, [done.key]))
  const finish = async () => {
    slow.value = true
    await cancel(live)
    await running
  }
  return { storage, k, parent, done, live, finish }
}

describe('web projections embed child traces on the owner span', () => {
  it('opening, history and patch turns match the full projection at the same cut', async () => {
    const { parent, done, live, finish } = await twoChildren()
    const full = await parent.projectUI()
    const opening = await parent.projectUIOpening({ surface: 'web', maxNodes: 500, maxBytes: MiB })
    expect(opening.timeline.upto).toBe(full.upto)
    expect(opening.timeline.turns).toEqual(full.turns.filter((turn) => byId(opening.timeline.turns, turn.id)))
    expect(subagentSpan(opening.timeline.turns, done.key)?.children.length).toBeGreaterThan(0)
    expect(subagentSpan(opening.timeline.turns, live.key)?.children[0]?.status).toBe('running')
    // The second spawn of the same child is not the owner and keeps its own (empty) children.
    const second = byId(opening.timeline.turns, 'turn:2')
    expect(second && subagentSpan([second], done.key)?.children).toEqual([])

    const windowed = await parent.projectUIOpening({ surface: 'web', maxNodes: 2, maxBytes: MiB })
    expect(windowed.hasEarlier).toBe(true)
    const history = await parent.projectUIHistory(windowed.timeline.upto, windowed.startIndex, {
      surface: 'web',
      limit: 200,
    })
    expect(history.turns.length).toBeGreaterThan(0)
    expect(history.turns).toEqual(full.turns.filter((turn) => byId(history.turns, turn.id)))

    // Children folded at the opening's head make the next patch send their owner turn once more.
    await parent.d.log.append([note('flush')])
    const p0 = await parent.projectUIPatch(opening.timeline.upto, undefined, { surface: 'web' })
    expect(upserted(p0).map((turn) => turn.id)).toEqual(['turn:1'])

    await finish()
    await parent.d.log.append([titleCost(2, 1)])
    const p1 = await parent.projectUIPatch(uptoOf(p0), undefined, { surface: 'web' })
    const turns = upserted(p1)
    let after = await parent.projectUI()
    expect(uptoOf(p1)).toBe(after.upto)
    // Turn 1 changed only through its child; turn 2 changed on the parent ledger.
    expect(turns.map((turn) => turn.id)).toEqual(['turn:1', 'turn:2'])
    for (const turn of turns) expect(turn).toEqual(byId(after.turns, turn.id))
    expect(subagentSpan(turns, live.key)?.children[0]?.status).toBe('cancelled')

    // A patch that changes only the later turn naming a child still matches the full projection.
    await parent.d.log.append([note('flush again')])
    const p2 = await parent.projectUIPatch(uptoOf(p1), undefined, { surface: 'web' })
    await parent.d.log.append([titleCost(2, 2)])
    const p3 = upserted(await parent.projectUIPatch(uptoOf(p2), undefined, { surface: 'web' }))
    after = await parent.projectUI()
    expect(p3.map((turn) => turn.id)).toEqual(['turn:2'])
    expect(p3[0]).toEqual(byId(after.turns, 'turn:2'))
    expect(p3[0] && subagentSpan([p3[0]], done.key)?.children).toEqual([])
  })

  it('embeds child trees in the replacement a web patch sends when its baseline left the journal', async () => {
    const { parent, done } = await twoChildren()
    const base = parent.lastSeq
    // More rows than the live journal keeps push that baseline below its floor.
    for (let i = 0; i < 2_100; i += 700)
      await parent.d.log.append(Array.from({ length: 700 }, (_, j) => note(`filler ${i + j}`)))
    const update = await parent.projectUIPatch(base, undefined, { surface: 'web' })
    if (update.kind !== 'replace') throw new Error('expected a replacement')
    const full = await parent.projectUI()
    expect(update.timeline.turns).toEqual(full.turns)
    expect(subagentSpan(update.timeline.turns, done.key)?.children.length).toBeGreaterThan(0)
  })

  it('leaves tui, channel and unspecified increments exactly as the cell produces them', async () => {
    const { parent, finish } = await twoChildren()
    for (const surface of [undefined, 'tui', 'channel'] as const) {
      const opts = surface ? { surface } : {}
      const opening = await parent.projectUIOpening({ ...opts, maxNodes: 3, maxBytes: MiB })
      const usage = opening.timeline.usage
      const direct = await parent.d.ui.opening({
        ...opts,
        maxNodes: 3,
        maxBytes: MiB,
        ...(usage ? { usage } : {}),
      })
      expect(JSON.stringify(opening)).toBe(JSON.stringify(direct))
      const history = await parent.projectUIHistory(opening.timeline.upto, opening.startIndex, {
        ...opts,
        limit: 2,
      })
      expect(JSON.stringify(history)).toBe(
        JSON.stringify(parent.d.ui.history(opening.timeline.upto, opening.startIndex, 2, 256 * 1024)),
      )
    }
    const before = parent.lastSeq
    await finish()
    await parent.d.log.append([row('user/message', { content: [{ type: 'text', text: 'more' }] })])
    for (const surface of [undefined, 'tui', 'channel'] as const) {
      const update = await parent.projectUIPatch(before, undefined, surface ? { surface } : {})
      if (update.kind !== 'patch') throw new Error('expected a live patch')
      expect(JSON.stringify(update.patch)).toBe(
        JSON.stringify(parent.d.ui.journalPatch(before, update.patch.usage)),
      )
    }
  })

  it('re-sends a turn to every client whose baseline predates the child change', async () => {
    const { parent, live, finish } = await twoChildren()
    const opening = await parent.projectUIOpening({ surface: 'web', maxNodes: 500, maxBytes: MiB })
    const base = opening.timeline.upto
    await finish()
    await parent.d.log.append([note('poke')])

    // Client A observes the child's new rows first.
    const a1 = upserted(await parent.projectUIPatch(base, undefined, { surface: 'web' }))
    expect(subagentSpan(a1, live.key)?.children[0]?.status).toBe('cancelled')
    const aUpto = parent.lastSeq
    // Client B still sits on the old baseline: the change was already folded, yet B gets the turn.
    const b1 = upserted(await parent.projectUIPatch(base, undefined, { surface: 'web' }))
    expect(subagentSpan(b1, live.key)?.children[0]?.status).toBe('cancelled')
    expect(byId(b1, 'turn:1')).toEqual(byId(a1, 'turn:1'))
    // A baseline equal to the head the change was seen at gets the turn once more, then no more.
    await parent.d.log.append([note('again')])
    const a2 = await parent.projectUIPatch(aUpto, undefined, { surface: 'web' })
    expect(byId(upserted(a2), 'turn:1')).toEqual(byId(a1, 'turn:1'))
    await parent.d.log.append([note('and again')])
    const a3 = upserted(
      await parent.projectUIPatch(a2.kind === 'patch' ? a2.patch.upto : 0, undefined, { surface: 'web' }),
    )
    expect(byId(a3, 'turn:1')).toBeUndefined()
  })

  it('delivers a child that finishes after the parent turn ended, through the patch its cost row drives', async () => {
    const { parent } = await setup(scripted(['the child answer']))
    const handle = await spawnChild(parent, 'child work')
    // The spawning turn ends while the child has not written anything yet.
    await parent.d.log.append(spawnTurn(1, [handle.key]))
    const opening = await parent.projectUIOpening({ surface: 'web', maxNodes: 500, maxBytes: MiB })
    expect(subagentSpan(opening.timeline.turns, handle.key)?.children).toEqual([])
    await parent.d.log.append([note('while the child works')])
    const p1 = await parent.projectUIPatch(opening.timeline.upto, undefined, { surface: 'web' })
    // Only the child's creation rows exist so far: no child turn is embedded yet.
    expect(subagentSpan(upserted(p1), handle.key)?.children ?? []).toEqual([])

    // The child writes all its rows; the parent's only event after that is the child's cost row.
    const before = parent.lastSeq
    await handle.run('child work')
    expect(parent.lastSeq).toBe(before + 1)
    const p2 = upserted(await parent.projectUIPatch(uptoOf(p1), undefined, { surface: 'web' }))
    const nested = subagentSpan(p2, handle.key)
    expect(nested?.children[0]?.status).toBe('completed')
    expect(byId(p2, 'turn:1')).toEqual(byId((await parent.projectUI()).turns, 'turn:1'))
  })

  it('probes every referenced child on each patch and folds nothing when no child moved', async () => {
    const { storage, parent } = await setup(scripted(['answer']))
    const keys: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const handle = await spawnChild(parent, `task ${i}`)
      await handle.run(`task ${i}`)
      keys.push(handle.key)
    }
    await parent.d.log.append(spawnTurn(1, keys))
    const opening = await parent.projectUIOpening({ surface: 'web', maxNodes: 500, maxBytes: MiB })
    // The children were folded at the opening's own head, so the first patch re-sends turn 1 once.
    await parent.d.log.append([note('flush')])
    const first = await parent.projectUIPatch(opening.timeline.upto, undefined, { surface: 'web' })
    expect(upserted(first).map((turn) => turn.id)).toEqual(['turn:1'])
    await parent.d.log.append([row('user/message', { content: [{ type: 'text', text: 'next' }] })])
    const lookup = vi.spyOn(storage, 'lookupByKey')
    const scan = vi.spyOn(storage, 'scan')
    const update = await parent.projectUIPatch(first.kind === 'patch' ? first.patch.upto : 0, undefined, {
      surface: 'web',
    })
    expect(lookup.mock.calls.map((call) => call[0]).sort()).toEqual([...keys].sort())
    const childScans = scan.mock.calls.filter((call) => keys.includes(call[0]))
    expect(childScans).toHaveLength(keys.length)
    for (const [, q] of childScans) expect(q.limit).toBeLessThanOrEqual(500)
    expect(await Promise.all(scan.mock.results.map((result) => result.value))).toSatisfy(
      (pages: unknown[][]) => pages.every((page) => page.length === 0),
    )
    expect(upserted(update)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// A child whose trace is far larger than one turn may carry.

/**
 * A child of `turns` turns with `calls` billed calls each, every call one span. Title calls are
 * used because they leave no per-call entry in the ledger state, which the fold copies per row.
 */
async function bigChild(k: Kernel, parent: SessionImpl, turns: number, calls: number, input = 'big') {
  const handle = await spawnChild(parent, input)
  const child = k.get(handle.key)
  if (!child) throw new Error('child session is not open')
  // Each turn is one append: a turn left open between appends would need its op.state register.
  for (let turn = 1; turn <= turns; turn += 1)
    await child.append([
      row('turn/start', { turn, trigger: 'prompt' }),
      ...Array.from({ length: calls }, (_, i) =>
        row('cost/ledger', {
          purpose: 'title',
          effectId: `call-${turn}-${i}`,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          creditSource: 'estimated',
          model: `model-${i}-${'m'.repeat(60)}`,
          sourceTurn: turn,
        }),
      ),
      row('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ])
  // Per turn: the turn root and one span per call.
  return { key: handle.key, spans: turns * (calls + 1) }
}

/** A parent with `messages` large user messages, then one turn that spawns the given child. */
async function bigSession(spans: number, messages: number) {
  const { storage, k, parent } = await setup(scripted(['answer']))
  const child = await bigChild(k, parent, Math.ceil(spans / 20), 19)
  for (let i = 0; i < messages; i += 500)
    await parent.d.log.append(
      Array.from({ length: Math.min(500, messages - i) }, (_, j) =>
        row('user/message', { content: [{ type: 'text', text: `${i + j}:${'x'.repeat(2_000)}` }] }),
      ),
    )
  await parent.d.log.append(spawnTurn(1, [child.key]))
  return { storage, k, parent, child }
}

const keptAndOmitted = (owner: UISpan | undefined) => {
  let kept = 0
  let omitted = 0
  for (const span of owner ? walk(owner).slice(1) : [])
    if (span.error?.code === 'TRACE_TRUNCATED') omitted += Number(span.error.message)
    else kept += 1
  return { kept, omitted }
}

describe('web projections bound a huge child trace per turn', () => {
  it('truncates a 20k-span child on the web and keeps the full projection whole', async () => {
    const { parent, child } = await bigSession(20_000, 0)
    const maxBytes = MiB - 4096
    const opening = await parent.projectUIOpening({ surface: 'web', maxNodes: 500, maxBytes })
    const turn = byId(opening.timeline.turns, 'turn:1')
    const owner = turn ? subagentSpan([turn], child.key) : undefined
    expect(truncations(owner).length).toBeGreaterThan(0)
    expect(embeddedBytes(turn)).toBeLessThanOrEqual(TRACE_SUBTREE_BUDGET)
    const { kept, omitted } = keptAndOmitted(owner)
    expect(kept + omitted).toBe(child.spans)
    for (const span of truncations(owner)) {
      expect(span).toMatchObject({ kind: 'other', name: 'trace-truncated', children: [] })
      expect(span.id.length).toBeLessThanOrEqual(128)
    }
    expect(bytes({ nodes: opening.timeline.nodes, turns: opening.timeline.turns })).toBeLessThanOrEqual(
      maxBytes,
    )

    const history = await parent.projectUIHistory(
      opening.timeline.upto,
      opening.timeline.nodes.length + opening.startIndex,
      {
        surface: 'web',
        limit: 200,
        maxBytes,
      },
    )
    expect(embeddedBytes(byId(history.turns, 'turn:1'))).toBeLessThanOrEqual(TRACE_SUBTREE_BUDGET)
    expect(truncations(subagentSpan(history.turns, child.key)).length).toBeGreaterThan(0)

    const full = await parent.projectUI(undefined, { surface: 'web' })
    const whole = subagentSpan(full.turns, child.key)
    expect(truncations(whole)).toEqual([])
    expect(whole ? walk(whole).length - 1 : 0).toBe(child.spans)
  }, 30_000)

  it('counts turn bytes when paging a web opening and history, on the live and the rebuilt path', async () => {
    const { parent, child } = await bigSession(20_000, 600)
    const maxBytes = MiB - 4096
    const check = (nodes: unknown[], turns: UITurn[]) => {
      expect(bytes({ nodes, turns })).toBeLessThanOrEqual(maxBytes)
      expect(embeddedBytes(byId(turns, 'turn:1'))).toBeLessThanOrEqual(TRACE_SUBTREE_BUDGET)
      expect(truncations(subagentSpan(turns, child.key)).length).toBeGreaterThan(0)
    }
    const live = await parent.projectUIOpening({ surface: 'web', maxNodes: 500, maxBytes })
    check(live.timeline.nodes, live.timeline.turns)
    const cut = live.timeline.upto
    const liveHistory = await parent.projectUIHistory(cut, live.startIndex + live.timeline.nodes.length, {
      surface: 'web',
      limit: 200,
      maxBytes,
    })
    check(liveHistory.nodes, liveHistory.turns)

    // A historical cut and an incomplete cell both take the rebuilt path; it is bounded the same way.
    await parent.d.log.append([row('user/message', { content: [{ type: 'text', text: 'later' }] })])
    const rebuiltHistory = await parent.projectUIHistory(cut, live.startIndex + live.timeline.nodes.length, {
      surface: 'web',
      limit: 200,
      maxBytes,
    })
    expect(JSON.stringify(rebuiltHistory)).toBe(JSON.stringify(liveHistory))
    markIncomplete(parent.d.ui)
    const rebuilt = await parent.projectUIOpening({ surface: 'web', maxNodes: 500, maxBytes })
    check(rebuilt.timeline.nodes, rebuilt.timeline.turns)
  }, 30_000)
})

describe('web patches bound what they re-send', () => {
  it('answers a replacement rather than re-sending more child trees than one page holds', async () => {
    const { k, parent } = await setupWide(scripted(['answer']))
    const keys: string[] = []
    for (let i = 0; i < 30; i += 1) keys.push((await bigChild(k, parent, 1, 60, `task ${i}`)).key)
    for (const [index, key] of keys.entries()) await parent.d.log.append(spawnTurn(index + 1, [key]))
    const opening = await parent.projectUIOpening({ surface: 'web', maxNodes: 2, maxBytes: MiB })
    // Every child was first folded at the opening's head, so each owner turn is due once more:
    // about 30 x 15 KB, more than a default projection page.
    await parent.d.log.append([note('poke')])
    const first = await parent.projectUIPatch(opening.timeline.upto, undefined, { surface: 'web' })
    expect(first.kind).toBe('replace')
    // The reopen at the new head sees no child change since, and its next patch re-sends nothing.
    const reopened = await parent.projectUIOpening({ surface: 'web', maxNodes: 2, maxBytes: MiB })
    await parent.d.log.append([note('again')])
    const next = await parent.projectUIPatch(reopened.timeline.upto, undefined, { surface: 'web' })
    expect(upserted(next)).toEqual([])
  }, 30_000)
})

// ---------------------------------------------------------------------------------------------
// The budgeted copy on synthetic trees.

const span = (id: string, children: UISpan[] = [], extra: Partial<UISpan> = {}): UISpan => ({
  id,
  kind: 'step',
  name: `name-${id}`,
  status: 'completed',
  startSeq: 1,
  startedAt: '2026-09-24T00:00:00.000Z',
  children,
  ...extra,
})

function randomTree(seed: number, spans: number): UISpan[] {
  let state = seed
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
  const roots: UISpan[] = []
  const all: UISpan[] = []
  for (let i = 0; i < spans; i += 1) {
    const item = span(`s${seed}-${i}-${'y'.repeat(Math.floor(next() * 40))}`)
    const parent = all.length > 0 && next() < 0.8 ? all[Math.floor(next() * all.length)] : undefined
    if (parent) parent.children.push(item)
    else roots.push(item)
    all.push(item)
  }
  return roots
}

function turnWith(owners: Array<{ key: string; id?: string }>): UITurn {
  return {
    id: 'turn:1',
    turn: 1,
    startSeq: 1,
    startedAt: '2026-09-24T00:00:00.000Z',
    status: 'completed',
    nodeIds: [],
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: false,
      calls: [],
    },
    inherited: false,
    forkable: true,
    trace: span(
      'turn:1',
      owners.map(({ key, id }) =>
        span(id ?? `span:subagent:${key}`, [], {
          kind: 'subagent',
          childSessionKey: key,
          name: 'subagent_spawn',
        }),
      ),
      { kind: 'turn' },
    ),
  }
}

const traceOf = (spans: UISpan[]): ChildTrace => ({
  spans,
  bytes: bytes(spans),
  changedAtParentSeq: 1 as Seq,
})
const count = (spans: readonly UISpan[]) => spans.reduce((sum, item) => sum + walk(item).length, 0)

describe('embedChildTraces', () => {
  it('copies whole trees unchanged while they fit and stays within budget when they do not', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const a = randomTree(seed, 40 + seed * 13)
      const b = randomTree(seed + 100, 25)
      const traces = new Map([
        ['a', traceOf(a)],
        ['b', traceOf(b)],
      ])
      const whole = bytes(a) - 2 + bytes(b) - 2
      // Each budget leaves room for both owners' placeholders (about 200 bytes each).
      for (const budget of [600, 900, 2_500, 7_000, whole - 1, whole, whole + 10]) {
        const turn = turnWith([{ key: 'a' }, { key: 'b' }])
        embedChildTraces(turn, subagentOwners([turn]), traces, budget)
        const [ownerA, ownerB] = turn.trace?.children ?? []
        expect(embeddedBytes(turn)).toBeLessThanOrEqual(budget)
        expect(keptAndOmitted(ownerA).kept + keptAndOmitted(ownerA).omitted).toBe(count(a))
        expect(keptAndOmitted(ownerB).kept + keptAndOmitted(ownerB).omitted).toBe(count(b))
        if (budget >= whole) {
          expect(ownerA?.children).toEqual(a)
          expect(ownerB?.children).toEqual(b)
        } else expect(truncations(ownerA).length + truncations(ownerB).length).toBeGreaterThan(0)
        for (const owner of [ownerA, ownerB])
          for (const item of owner ? walk(owner) : []) {
            const last = item.children.at(-1)
            for (const child of item.children.slice(0, -1))
              expect(child.error?.code).not.toBe('TRACE_TRUNCATED')
            if (last?.error?.code === 'TRACE_TRUNCATED') expect(last.children).toEqual([])
          }
      }
      // The shared trees are never modified.
      expect(traces.get('a')?.spans).toBe(a)
      expect(bytes(a)).toBe(traces.get('a')?.bytes)
    }
  })

  it('names a placeholder after its container, clipped to the span id limit', () => {
    const longId = `span:subagent:${'z'.repeat(114)}`
    expect(longId.length).toBe(128)
    const turn = turnWith([{ key: 'k', id: longId }])
    const tree = randomTree(7, 300)
    embedChildTraces(turn, subagentOwners([turn]), new Map([['k', traceOf(tree)]]), 600)
    const owner = turn.trace?.children[0]
    const marks = truncations(owner)
    expect(marks.length).toBeGreaterThan(0)
    for (const mark of marks) expect(mark.id.length).toBeLessThanOrEqual(128)
    expect(owner?.children.at(-1)?.id).toBe(`${longId.slice(0, 118)}:truncated`)
    expect(owner?.children.at(-1)).toMatchObject({ status: owner?.status, startSeq: owner?.startSeq })

    // A cut that would split a surrogate pair drops the pair whole.
    const astral = `span:subagent:${'z'.repeat(103)}\u{1F600}${'z'.repeat(10)}`
    expect(astral.slice(0, 118).at(-1)?.charCodeAt(0)).toBe(0xd83d)
    const split = turnWith([{ key: 'k', id: astral }])
    embedChildTraces(split, subagentOwners([split]), new Map([['k', traceOf(tree)]]), 600)
    expect(split.trace?.children[0]?.children.at(-1)?.id).toBe(`${astral.slice(0, 117)}:truncated`)
  })

  it('embeds only on the first span naming a child and leaves unresolved children alone', () => {
    const turn = turnWith([{ key: 'a' }, { key: 'a', id: 'span:subagent:again' }, { key: 'missing' }])
    const tree = randomTree(3, 5)
    embedChildTraces(turn, subagentOwners([turn]), new Map([['a', traceOf(tree)]]), TRACE_SUBTREE_BUDGET)
    expect(turn.trace?.children[0]?.children).toEqual(tree)
    expect(turn.trace?.children[1]?.children).toEqual([])
    expect(turn.trace?.children[2]?.children).toEqual([])
  })
})
