import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { batchTrigger, type ForkBase, forkBaseProviders } from '../src/log/fork-seed.js'
import { verifyLedger } from '../src/log/integrity.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { SessionLogImpl } from '../src/log/session-log.js'
import type { IntegrityCommit, OpWrite } from '../src/log/storage.js'
import { SurfaceCache, seedSurface } from '../src/project/surface.js'
import { markIncomplete, UIProjectionCell } from '../src/project/ui.js'
import { openTracked } from '../src/reduce/tracker.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { newOpState } from '../src/step/op-state.js'
import type { Event, EventInput, Seq } from '../src/types.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, shellTool } from './helpers/open-session.js'

const row = (seq: Seq, type: string, lane = 'main', data: unknown = {}): Event =>
  ({ seq, type, lane, data, actor, origin: 'principal', trust: 'trusted', ts: 't', id: `e${seq}` }) as Event

describe('surface watermark, snapshot and seeding', () => {
  it('advances its watermark on every row it is handed, any lane or type', () => {
    const surface = new SurfaceCache('main')
    expect(surface.upto).toBe(0)
    surface.push([row(1, 'user/message'), row(2, 'x/core/op-mark'), row(3, 'user/message', 'side')])
    expect(surface.upto).toBe(3)
  })

  it('keeps a snapshot unchanged by later pushes and pins', () => {
    const surface = new SurfaceCache('main')
    surface.push([row(1, 'user/message'), row(2, 'assistant/message')])
    const snap = surface.snapshot()
    surface.pin(1)
    surface.push([row(3, 'user/message')])
    expect(snap.nodes.map((n) => [n.seq, n.pinned])).toEqual([
      [1, false],
      [2, false],
    ])
  })

  it('seeds a child surface without pins and without rows past the fork point', () => {
    const surface = new SurfaceCache('main')
    surface.push([row(1, 'user/message'), row(2, 'assistant/message')])
    surface.pin(2)
    const snap = surface.snapshot()
    surface.push([row(3, 'user/message')])
    const child = seedSurface('main', snap, 2)
    expect(child.nodes().map((n) => [n.seq, n.pinned])).toEqual([
      [1, false],
      [2, false],
    ])
    expect([...child.eventsById().keys()]).toEqual([1, 2])
    expect(child.upto).toBe(2)
    expect(child.replaceGeneration).toBe(snap.replaceGeneration)
    // The seed shares nothing mutable with the parent: pinning the child leaves the parent alone.
    child.pin(1)
    expect(surface.nodes().find((n) => n.seq === 1)?.pinned).toBe(false)
  })
})

describe('UI cell completeness', () => {
  it('is complete unless core marks it otherwise', () => {
    const cell = new UIProjectionCell('k')
    expect(cell.complete).toBe(true)
    markIncomplete(cell)
    expect(cell.complete).toBe(false)
  })
})

describe('onAppended carries the committed integrity entries', () => {
  it('passes the entries storage stored, in order', async () => {
    const storage = new MemoryStorage()
    const seen: Array<readonly IntegrityCommit[] | undefined> = []
    const log = await SessionLogImpl.open({
      storage,
      key: 'k',
      writerRunId: 'w',
      ttlMs: 60_000,
      ids: defaultIds(),
      clock: () => 0,
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      onAppended: (_events, { integrity }) => {
        seen.push(integrity)
      },
    })
    const note: EventInput = {
      actor,
      origin: 'principal',
      trust: 'trusted',
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'x' }] },
    }
    await log.append([note, note])
    const stored = await storage.scanIntegrity('k', { fromSeq: 1, toSeq: 2, limit: 2 })
    expect(seen).toEqual([stored.map((r) => ({ seq: r.event.seq, ...r.integrity }))])
    await log.close()
  })
})

describe('a batch that opens a turn names its trigger', () => {
  it('reads the trigger from the op write when that trigger lies inside the batch', () => {
    const op = (triggerSeq: Seq) => ({ lane: 'main', data: { meta: { triggerSeq } } }) as unknown as OpWrite
    expect(batchTrigger([row(4, 'user/message'), row(5, 'turn/start')], op(4))).toBe(4)
    expect(batchTrigger([row(9, 'x/core/op-mark')], op(4))).toBeUndefined()
    expect(batchTrigger([row(9, 'turn/end')], { lane: 'main', data: null })).toBeUndefined()
    expect(batchTrigger([row(4, 'user/message')], undefined)).toBeUndefined()
  })
})

type Opened = Awaited<ReturnType<typeof openSession>>
const provide = (h: Opened, b: Seq): ForkBase | undefined => forkBaseProviders.get(h.log)?.(b, 'main')
const triggerOf = (h: Opened): Seq =>
  (h.log.latest('op.state', 'main') as { meta: { triggerSeq: Seq } }).meta.triggerSeq

async function expectTriggerAt(h: Opened, c: Seq): Promise<void> {
  const base = provide(h, c)
  expect(base).toMatchObject({ kind: 'trigger', seq: c })
  const verified = await verifyLedger(h.storage, h.log.key, c)
  expect(base?.kind === 'trigger' && base.headDigest).toBe(verified.headDigest)
  expect(base?.state.lastSeq).toBe(c)
  expect(
    Math.max(...(base?.surface.nodes.map((n) => n.seq) ?? [Number.POSITIVE_INFINITY])),
  ).toBeLessThanOrEqual(c)
}

describe('the parent keeps a fork point', () => {
  it('at the trigger of an accepted turn', async () => {
    const h = await openSession({ provider: fakeProvider([textTurn('a')]) })
    await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
    await h.session.acceptInput()
    const c = triggerOf(h)
    expect(h.log.lastSeq).toBeGreaterThan(c)
    await expectTriggerAt(h, c)
    // At the head, with everything folded, the head itself is the point.
    expect(provide(h, h.log.lastSeq)).toMatchObject({ kind: 'head', seq: h.log.lastSeq })
    // A boundary before the only point has nothing to seed from.
    expect(provide(h, c - 1)).toBeUndefined()
    await h.session.close()
  })

  it('at the trigger of a requested compaction', async () => {
    const h = await openSession({ provider: fakeProvider([textTurn('a')]) })
    await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
    await h.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await h.session.requestCompaction({ actor, admissionId: 'adm-1' })
    await expectTriggerAt(h, triggerOf(h))
    await h.session.close()
  })

  it('at the trigger of a parked tool continuation, and not at a later op.state rewrite', async () => {
    const now = 1_757_203_200_000
    const clock = () => now
    const registry = new ToolRegistry()
    registry.add(shellTool(), { source: 'test', trust: 'builtin' })
    const receipts = new Map<string, { requestId: string; bindingHash: string; expiresAt: string }>()
    const seams = fakeSeams({
      principals: { authorize: async () => ({ decisionId: 'auth', effect: 'allow', reason: 'ok' }) },
      approval: {
        ask: async (req) => {
          const expiresAt = new Date(now + 1000).toISOString()
          receipts.set('t1', { requestId: req.requestId, bindingHash: req.bindingHash, expiresAt })
          return { ticket: 't1', expiresAt }
        },
        resume: async (ticket) => receipts.get(ticket) ?? null,
      },
    })
    const h = await openSession({
      storage: new MemoryStorage({ clock }),
      clock,
      registry,
      seams,
      provider: fakeProvider([toolTurn('shell', { command: 'echo' }), textTurn('done')]),
    })
    await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
    const signal = new AbortController().signal
    expect((await h.session.run({ until: 'turn-end', signal })).reason).toBe('parked')
    await h.session.resumeApproval('t1', 'allowed-once', { ...actor, id: 'approver' })
    await h.session.step()
    const c = triggerOf(h)
    await expectTriggerAt(h, c)
    // Later steps rewrite op.state with the same trigger, which is outside their batch: the point stays.
    await h.session.step()
    expect(triggerOf(h)).toBe(c)
    await expectTriggerAt(h, c)
    await h.session.close()
  })

  it('at the trigger of a verifier continuation', async () => {
    let checks = 0
    let receipt: { requestId: string; bindingHash: string; expiresAt: string } | null = null
    const seams = fakeSeams({
      verifier: {
        verify: async () =>
          ++checks === 1 ? { verdict: 'fail', reasons: ['needs review'] } : { verdict: 'pass', reasons: [] },
      },
      repair: { decide: async () => 'park' },
      approval: {
        ask: async (req) => {
          receipt = {
            requestId: req.requestId,
            bindingHash: req.bindingHash,
            expiresAt: '2099-01-01T00:00:00Z',
          }
          return { ticket: 'review', expiresAt: receipt.expiresAt }
        },
        resume: async () => receipt,
      },
    })
    const h = await openSession({ seams, provider: fakeProvider([textTurn('first'), textTurn('second')]) })
    await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
    const signal = new AbortController().signal
    expect((await h.session.run({ until: 'turn-end', signal })).reason).toBe('parked')
    await h.session.resumeApproval('review', 'allowed-once', { ...actor, id: 'reviewer' })
    await h.session.step()
    // The continuation's turn/start is its trigger and the head; one more row moves the head past it.
    expect(h.log.lastSeq).toBe(triggerOf(h))
    await h.session.diag('contribute-conflict', {})
    await expectTriggerAt(h, triggerOf(h))
    await h.session.close()
  })

  it('keeps no point once a second lane is registered', async () => {
    const { log, surfaces } = await openTracked({
      storage: new MemoryStorage(),
      key: 'k',
      writerRunId: 'w',
      ttlMs: 60_000,
      ids: defaultIds(),
      clock: () => 0,
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    })
    const message: EventInput = {
      actor,
      origin: 'principal',
      trust: 'trusted',
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'x' }] },
    }
    const opState = (triggerSeq: Seq) =>
      newOpState(
        {
          turn: 1,
          lane: 'main',
          acceptedAt: '2026-09-24T00:00:00.000Z',
          triggerSeq,
          presetName: 'standard',
          profileHash: null,
          depthLimit: 3,
        },
        triggerSeq,
      )
    const turnStart: EventInput = {
      actor,
      origin: 'system',
      trust: 'trusted',
      type: 'turn/start',
      data: { turn: 1, trigger: 'prompt' },
    }
    await log.append([message, turnStart], { opState: { lane: 'main', data: opState(1) } })
    expect(forkBaseProviders.get(log)?.(1, 'main')).toMatchObject({ kind: 'trigger', seq: 1 })
    surfaces.set('side', new SurfaceCache('side'))
    expect(forkBaseProviders.get(log)?.(1, 'main')).toBeUndefined()
    expect(forkBaseProviders.get(log)?.(log.lastSeq, 'main')).toBeUndefined()
    await log.close()
  })
})
