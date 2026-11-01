import type { Event } from '@agnes/core-common/types'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { InferenceEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createLoopContext } from '../src/loop/ports.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { atReview, input, ran, reopen, run, signal } from './helpers/completion-review.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor, readTool, writeTool } from './helpers/open-session.js'

describe('durable additional completion review recovery', () => {
  it.each(['main', 'secondary'])(
    'joins cold history and hot admissions exactly once on lane %s',
    async (lane) => {
      let h = await atReview({ lane })
      h.session.preset.completionGate.contractReview = false
      h = await reopen(h, { lane })
      const coldHead = h.session.lastSeq
      const ctx = await createLoopContext(h.session)
      const scan = h.storage.scan.bind(h.storage)
      const reads: Event[] = []
      const snapshots: Event[] = []
      let entered: () => void = () => undefined
      let release: () => void = () => undefined
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      let held = false
      h.storage.scan = async (key, query) => {
        const rows = await scan(key, query)
        reads.push(...rows)
        if (!held && Array.isArray(query.type) && query.type.includes('x/core/completion-review-anchor')) {
          held = true
          const copy = structuredClone(rows)
          snapshots.push(...copy)
          entered()
          await barrier
          return copy
        }
        return rows
      }
      const admission = async () => {
        const effect = h.session.effects.start({ kind: 'inference', replay: 'never', slot: 'main' })
        await h.session.append([effect.intent, effect.settle('error')])
      }
      let preparing: ReturnType<typeof ctx.prepareRequest> | undefined
      try {
        // One committed tail precedes the cold scan; another arrives while its fixed prefix waits.
        await admission()
        preparing = ctx.prepareRequest()
        void preparing.catch(() => undefined)
        await ready
        const other = lane === 'main' ? 'secondary' : 'main'
        const foreign = h.session.effects.start({ kind: 'inference', replay: 'never', slot: 'main' })
        await h.session.append([
          h.session.ev('turn/start', { turn: 1, trigger: 'prompt' }, { lane: other }),
          h.session.ev(
            'x/core/completion-gate',
            {
              diagnostic: 'completion_gate_contract_review',
              status: 'ran',
              reviewBudget: null,
            },
            { lane: other, ignorable: true },
          ),
          { ...foreign.intent, lane: other },
          { ...foreign.settle('error'), lane: other },
          h.session.ev('turn/end', { reason: 'completed', lastAssistantSeq: null }, { lane: other }),
        ])
        await admission()
        const refused = h.session.effects.start({ kind: 'inference', replay: 'never', slot: 'main' })
        await expect(
          h.log.append([refused.intent, refused.settle('error')], {
            expectedRegisterSeq: { register: 'op.state', key: lane, seq: 0 },
          }),
        ).rejects.toMatchObject({ code: 'E_CAS' })
        release()
        const request = await preparing
        expect(snapshots.some((row) => row.type === 'x/core/completion-gate')).toBe(true)
        // Storage readers can retain mutable return values; the private prefix must be a snapshot.
        for (const row of snapshots) if (row.type === 'x/core/completion-gate') row.data = null
        await ctx.model.complete(request, signal())
        await expect(ctx.prepareRequest()).rejects.toMatchObject({ code: 'COMPLETION_REVIEW_REQUEST_LIMIT' })
        const historyReads = reads.filter((row) =>
          ['turn/start', 'effect/intent', 'x/core/completion-gate'].includes(row.type),
        )
        expect(historyReads.length).toBeGreaterThan(0)
        expect(historyReads.every((row) => row.seq <= coldHead && row.lane === lane)).toBe(true)
        expect(new Set(historyReads.map((row) => row.seq)).size).toBe(historyReads.length)
        h.storage.scan = scan
        const anchor = await ran(h)
        const intents = await h.log.scan({ type: 'effect/intent', lane, fromSeq: anchor.seq, limit: 100 })
        expect(intents.filter((row) => (row.data as { kind: string }).kind === 'inference')).toHaveLength(3)
        expect(h.provider.requests).toHaveLength(3)
        expect((await run(h)).reason).toBe('blocked')
        expect(h.session.pendingEffects()).toEqual([])
        expect((await h.log.scan({ type: 'turn/end', lane, limit: 10 }))[0]?.data).toMatchObject({
          error: { code: 'COMPLETION_REVIEW_REQUEST_LIMIT' },
        })
      } finally {
        release()
        h.storage.scan = scan
        await h.session.close()
        await preparing?.catch(() => undefined)
      }
    },
  )

  it('refuses a recovered Host effect second dispatch through the default batch', async () => {
    let hostDispatches = 0
    const registry = new ToolRegistry()
    registry.add(writeTool(), { source: 'test', trust: 'builtin' })
    registry.add(readTool(), {
      source: 'agnes/computer-use',
      trust: 'builtin',
      packageIdentity: '@agnes/base',
      packageVersion: '1.0.0',
      executionDomain: 'host-computer-use',
    })
    const hostToolDispatch = {
      dispatch: async () => {
        hostDispatches++
        return { phase: 'responded' as const, result: { content: [] } }
      },
    }
    const provider = fakeProvider([
      toolTurn('write_note', {}),
      textTurn('candidate'),
      toolTurn('read', {}),
      textTurn('checked'),
    ])
    let h = await atReview({ registry, provider, hostToolDispatch })
    const anchor = await ran(h)
    const budget = (anchor.data as { reviewBudget: unknown }).reviewBudget
    // Capture a historical-reader execution without the optional budget, then restore the trusted
    // full anchor in the crash prefix: a newer runtime must not dispatch that old effect again.
    let rows = await h.log.scan({ limit: 1000 })
    delete (rows.find((row) => row.seq === anchor.seq)!.data as { reviewBudget?: unknown }).reviewBudget
    let cells = h.log.allRegisters().filter((row) => row.register === 'op.state')
    h = await reopen(h, {
      storage: MemoryStorage.fromEvents('k', rows, { opCells: cells }),
      hostToolDispatch,
    })
    expect((await run(h)).reason).toBe('completed')
    expect(hostDispatches).toBe(1)
    rows = await h.log.scan({ limit: 1000 })
    const result = rows.find((row) => row.seq > anchor.seq && row.type === 'tool/result')!
    cells = h.opCellsBefore(result.seq)
    rows = rows.filter((row) => row.seq <= cells[0]!.seq)
    ;(rows.find((row) => row.seq === anchor.seq)!.data as { reviewBudget: unknown }).reviewBudget = budget
    h = await reopen(h, {
      storage: MemoryStorage.fromEvents('k', rows, { opCells: cells }),
      hostToolDispatch,
    })
    try {
      expect((await h.session.resume()).actions).toEqual([{ effectId: expect.any(String), action: 'rerun' }])
      const before = provider.requests.length
      expect((await run(h)).reason).toBe('blocked')
      expect(hostDispatches).toBe(1)
      expect(provider.requests).toHaveLength(before)
      const intents = await h.log.scan({ type: 'effect/intent', fromSeq: anchor.seq, limit: 50 })
      expect(intents.filter((row) => (row.data as { kind: string }).kind === 'tool')).toHaveLength(1)
      expect(h.session.pendingEffects()).toEqual([])
      expect((await h.log.scan({ type: 'turn/end', limit: 10 }))[0]?.data).toMatchObject({
        error: { code: 'COMPLETION_REVIEW_UNAVAILABLE' },
      })
    } finally {
      await h.session.close()
    }
  })

  it.each(['cleanup', 'terminal', 'cancelled-cleanup'] as const)(
    'leaves a replacement turn untouched by a stale %s closer',
    async (edge) => {
      let now = 1_757_203_200_000
      const provider = fakeProvider([
        toolTurn('write_note', {}),
        textTurn('candidate'),
        toolTurn('read', {}),
        textTurn('next answer'),
      ])
      const h = await atReview({ provider, clock: () => now })
      const anchor = await ran(h)
      for (
        let n = 0;
        n < 10 && !(await h.log.scan({ type: 'tool/call', fromSeq: anchor.seq, limit: 10 })).length;
        n++
      )
        await h.session.step()
      let release: () => void = () => undefined
      let entered: () => void = () => undefined
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const transition = h.session.transition
      const endTurn = h.session.endTurn
      const receipts = h.session.waitForReviewReceipts.bind(h.session)
      if (edge === 'cancelled-cleanup')
        h.session.waitForReviewReceipts = async () => {
          await receipts()
          await h.session.abort()
        }
      let held = false
      h.session.transition = async function (events, next, options) {
        const rows =
          edge === 'cancelled-cleanup' && typeof events === 'function' ? events(this.lastSeq + 1) : events
        if (
          !held &&
          (edge === 'cleanup' || edge === 'cancelled-cleanup') &&
          Array.isArray(rows) &&
          rows.some(
            (row) =>
              row.type === 'tool/result' &&
              (row.data as { code?: string }).code ===
                (edge === 'cleanup' ? 'TOOL_NOT_STARTED' : 'CANCELLED'),
          )
        ) {
          held = true
          entered()
          await barrier
        }
        return transition.call(this, events, next, options)
      }
      h.session.endTurn = async function (reason, extra) {
        if (edge === 'terminal' && reason === 'blocked') {
          entered()
          await barrier
        }
        return endTurn.call(this, reason, extra)
      }
      now += 60_000
      try {
        const running = run(h)
        await ready
        await h.session.abort()
        expect((await h.session.step()).reason).toBe('aborted')
        await h.session.restartLoopDriver()
        await h.session.enqueue('next-turn', input)
        expect(await h.session.acceptInput()).toBe(true)
        const next = structuredClone(h.session.op()?.meta)
        release()
        expect((await running).reason).toBe('aborted')
        expect(h.session.op()?.meta).toEqual(next)
        expect(await h.log.scan({ type: 'turn/end', limit: 10 })).toHaveLength(1)
        expect((await run(h)).reason).toBe('completed')
        expect(provider.requests).toHaveLength(4)
        expect(h.session.pendingEffects()).toEqual([])
      } finally {
        release()
        await h.session.close()
      }
    },
  )

  it.each(['cancel', 'interrupt'] as const)(
    'preserves a %s committed while review cleanup is waiting to write',
    async (control) => {
      let now = 1_757_203_200_000
      const provider = fakeProvider([
        toolTurn('write_note', {}),
        textTurn('candidate'),
        toolTurn('read', {}),
        textTurn('must not run'),
      ])
      const h = await atReview({ provider, clock: () => now })
      const anchor = await ran(h)
      for (
        let n = 0;
        n < 10 && !(await h.log.scan({ type: 'tool/call', fromSeq: anchor.seq, limit: 10 })).length;
        n++
      )
        await h.session.step()
      let release: () => void = () => undefined
      let entered: () => void = () => undefined
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const transition = h.session.transition
      h.session.transition = async function (events, next, options) {
        if (
          Array.isArray(events) &&
          events.some(
            (row) =>
              row.type === 'tool/result' && (row.data as { code?: string }).code === 'TOOL_NOT_STARTED',
          )
        ) {
          entered()
          await barrier
        }
        return transition.call(this, events, next, options)
      }
      if (control === 'interrupt') await h.session.enqueue('next-turn', input)
      const queued =
        control === 'interrupt' ? (await h.session.controls.state()).pending[0]?.itemId : undefined
      let requested: () => void = () => undefined
      const recorded = new Promise<void>((resolve) => {
        requested = resolve
      })
      const unsubscribe = h.log.observeCommitted(['x/core/control'], (rows) => {
        if (
          rows.some(
            (row) =>
              (row.data as { admissionId?: string; outcome?: string }).admissionId === 'cleanup-race' &&
              (row.data as { outcome?: string }).outcome === 'requested',
          )
        )
          requested()
      })
      now += 60_000
      try {
        const running = run(h)
        await ready
        const applied = h.session.controls.apply(control, actor, 'cleanup-race', queued)
        await recorded
        release()
        expect((await running).reason).toBe(control === 'interrupt' ? 'interrupted' : 'aborted')
        await applied
        const [end] = await h.log.scan({ type: 'turn/end', limit: 10 })
        expect(end?.data).toMatchObject({ reason: control === 'interrupt' ? 'interrupted' : 'aborted' })
        expect(end?.data).not.toHaveProperty('error')
        expect(
          (await h.log.scan({ type: 'x/core/control', limit: 100 })).some(
            (row) =>
              (row.data as { admissionId?: string; outcome?: string }).admissionId === 'cleanup-race' &&
              (row.data as { outcome?: string }).outcome === 'applied',
          ),
        ).toBe(true)
        expect(h.session.pendingEffects()).toEqual([])
        expect(h.session.state.openStep.size).toBe(0)
        expect(provider.requests).toHaveLength(3)
      } finally {
        release()
        unsubscribe()
        await h.session.close()
      }
    },
  )

  it('parks an unobserved mutation at the live deadline and reconciles it without replay', async () => {
    let now = 1_757_203_200_000
    const timers = new Map<number, { at: number; fn: () => void }>()
    let nextTimer = 0
    let release: () => void = () => undefined
    let entered: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let writes = 0
    const registry = new ToolRegistry()
    registry.add(
      writeTool(async () => {
        if (++writes > 1) {
          entered()
          await waiting
        }
        return { content: [] }
      }),
      { source: 'test', trust: 'builtin' },
    )
    const provider = fakeProvider([
      toolTurn('write_note', {}),
      textTurn('candidate'),
      toolTurn('write_note', {}),
      textTurn('must not run'),
    ])
    let h = await atReview({
      registry,
      provider,
      clock: () => now,
      timers: {
        setTimeout: (fn, ms) => {
          const id = ++nextTimer
          timers.set(id, { at: now + ms, fn })
          return id
        },
        clearTimeout: (handle) => {
          timers.delete(handle as number)
        },
      },
    })
    try {
      const running = run(h)
      await ready
      now += 60_000
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id)
          timer.fn()
        }
      expect((await running).reason).toBe('parked')
      const [end] = await h.log.scan({ type: 'turn/end', limit: 10 })
      expect(end?.data).toMatchObject({ reason: 'parked' })
      expect(end?.data).not.toHaveProperty('error')
      expect(
        (await h.log.scan({ type: 'effect/settled', limit: 100 })).some(
          (row) => (row.data as { outcome: string }).outcome === 'unknown',
        ),
      ).toBe(true)
      expect(h.session.ac.signal.aborted).toBe(false)
      expect(h.session.pendingEffects()).toEqual([])
      release()
      h = await reopen(h, { clock: () => now })
      const q = (await h.session.decisions.list()).find((q) => q.request.spec.purpose === 'unknown-outcome')!
      await h.session.decisions.answer(
        {
          handle: q.handle,
          revision: q.revision,
          commandId: 'reconcile',
          response: { option: 'allowed-once', value: null },
        },
        { actor, category: 'human', authorize() {} },
      )
      expect((await run(h)).reason).toBe('blocked')
      expect(writes).toBe(2)
      expect(provider.requests).toHaveLength(3)
      expect((await h.log.scan({ type: 'turn/end', order: 'desc', limit: 1 }))[0]?.data).toMatchObject({
        error: { code: 'COMPLETION_REVIEW_TIME_LIMIT' },
      })
    } finally {
      release()
      await h.session.close()
    }
  })

  it.each(['null', 'foreign', 'duplicate', 'missing'] as const)(
    'refuses a %s continuation anchor even when the preset is disabled',
    async (corruption) => {
      let writes = 0
      const registry = new ToolRegistry()
      registry.add(
        writeTool(async () => {
          if (++writes > 1) throw new Error('receipt lost')
          return { content: [] }
        }),
        { source: 'test', trust: 'builtin' },
      )
      const provider = fakeProvider([
        toolTurn('write_note', {}),
        textTurn('candidate'),
        toolTurn('write_note', {}),
        textTurn('must not run'),
      ])
      let h = await atReview({ registry, provider })
      expect((await run(h)).reason).toBe('parked')
      const q = (await h.session.decisions.list()).find((q) => q.request.spec.purpose === 'unknown-outcome')!
      await h.session.decisions.answer(
        {
          handle: q.handle,
          revision: q.revision,
          commandId: 'reconcile',
          response: { option: 'allowed-once', value: null },
        },
        { actor, category: 'human', authorize() {} },
      )
      for (
        let n = 0;
        n < 10 && !(await h.log.scan({ type: 'x/core/completion-review-anchor', limit: 10 })).length;
        n++
      )
        await h.session.step()
      const [ref] = await h.log.scan({ type: 'x/core/completion-review-anchor', limit: 10 })
      expect(ref).toBeDefined()
      expect(h.session.op()).toBeTruthy()
      const before = provider.requests.length
      h.session.preset.completionGate.contractReview = false
      if (corruption === 'duplicate')
        await h.session.append([
          h.session.ev(ref!.type, ref!.data, {
            ignorable: true,
            sourceEventSeqs: ref!.sourceEventSeqs ?? [],
          }),
        ])
      const rows = await h.log.scan({ limit: 1000 })
      const cells = h.log.allRegisters().filter((row) => row.register === 'op.state')
      const stored = rows.find((row) => row.seq === ref!.seq)!
      if (corruption === 'null') stored.data = null
      if (corruption === 'foreign') stored.data = { ...(stored.data as object), sessionKey: 'other-session' }
      if (corruption === 'missing') stored.type = 'x/test/omitted-anchor'
      h = await reopen(h, { storage: MemoryStorage.fromEvents('k', rows, { opCells: cells }) })
      try {
        expect((await run(h)).reason).toBe('blocked')
        expect(provider.requests).toHaveLength(before)
        expect(writes).toBe(2)
        expect(h.session.pendingEffects()).toEqual([])
        expect((await h.log.scan({ type: 'turn/end', order: 'desc', limit: 1 }))[0]?.data).toMatchObject({
          error: { code: 'COMPLETION_REVIEW_UNAVAILABLE' },
        })
      } finally {
        await h.session.close()
      }
    },
  )

  it('retains one allowance through two physical reconciliation continuations and a final third inference', async () => {
    let writes = 0
    const registry = new ToolRegistry()
    registry.add(
      writeTool(async () => {
        if (++writes > 1) throw new Error('unknown receipt')
        return { content: [{ type: 'text', text: 'written' }] }
      }),
      { source: 'test', trust: 'builtin' },
    )
    const provider = fakeProvider([
      toolTurn('write_note', {}),
      textTurn('candidate'),
      toolTurn('write_note', {}),
      toolTurn('write_note', {}),
      textTurn('final answer'),
    ])
    let h = await atReview({ registry, provider })
    const budget = (await ran(h)).data
    try {
      for (let n = 0; n < 2; n++) {
        expect((await run(h)).reason).toBe('parked')
        h = await reopen(h)
        const q = (await h.session.decisions.list()).find(
          (q) => q.request.spec.purpose === 'unknown-outcome' && !q.consumption,
        )!
        await h.session.decisions.answer(
          {
            handle: q.handle,
            revision: q.revision,
            commandId: `answer-${n}`,
            response: { option: 'allowed-once', value: null },
          },
          { actor, category: 'human', authorize() {} },
        )
      }
      expect((await run(h)).reason).toBe('completed')
      expect(provider.requests).toHaveLength(5)
      expect(writes).toBe(3)
      expect((await ran(h)).data).toEqual(budget)
      const refs = await h.log.scan({ type: 'x/core/completion-review-anchor', limit: 10 })
      expect(refs).toHaveLength(2)
      expect(new Set(refs.map((row) => (row.data as { ranSeq: number }).ranSeq)).size).toBe(1)
      expect(h.session.pendingEffects()).toEqual([])
      expect((await h.session.decisions.list()).every((q) => q.consumption)).toBe(true)
    } finally {
      await h.session.close()
    }
  })

  it.each(['missing', 'null', 'partial', 'version', 'fraction', 'duration', 'duplicate'] as const)(
    'treats only a wholly missing budget as legacy (%s)',
    async (corruption) => {
      let h = await atReview()
      const anchor = await ran(h)
      const rows = await h.log.scan({ fromSeq: 1, toSeq: h.log.lastSeq, limit: 10_000 })
      const cells = h.log.allRegisters().filter((cell) => cell.register === 'op.state')
      const row = rows.find((row) => row.seq === anchor.seq)!
      const data = row.data as { reviewBudget?: unknown }
      const budget = data.reviewBudget as Record<string, unknown>
      if (corruption === 'missing') delete data.reviewBudget
      if (corruption === 'null') data.reviewBudget = null
      if (corruption === 'partial') data.reviewBudget = { version: 1 }
      if (corruption === 'version') data.reviewBudget = { ...budget, version: 2 }
      if (corruption === 'fraction') data.reviewBudget = { ...budget, startedAt: 1.5 }
      if (corruption === 'duration')
        data.reviewBudget = { ...budget, deadlineAt: Number(budget.startedAt) + 60_001 }
      if (corruption === 'duplicate')
        await h.session.append([h.session.ev('x/core/completion-gate', anchor.data, { ignorable: true })])
      else h = await reopen(h, { storage: MemoryStorage.fromEvents('k', rows, { opCells: cells }) })
      try {
        const before = h.provider.requests.length
        expect((await run(h)).reason).toBe(corruption === 'missing' ? 'completed' : 'blocked')
        expect(h.provider.requests.length - before).toBe(corruption === 'missing' ? 1 : 0)
        if (corruption !== 'missing')
          expect((await h.log.scan({ type: 'turn/end', limit: 10 }))[0]?.data).toMatchObject({
            error: { code: 'COMPLETION_REVIEW_UNAVAILABLE' },
          })
        expect(h.session.pendingEffects()).toEqual([])
      } finally {
        await h.session.close()
      }
    },
  )

  it('preserves failed admissions, absolute time and the disabled-in-flight budget across two reopenings', async () => {
    const failure: InferenceEvent[] = [
      { type: 'error', reason: 'error', code: 'TRANSPORT', message: 'no receipt', retryable: true },
    ]
    const provider = fakeProvider([
      toolTurn('write_note', {}),
      textTurn('candidate'),
      failure,
      failure,
      failure,
      textTurn('must not dispatch'),
    ])
    let h = await atReview({ provider })
    const budget = (await ran(h)).data
    try {
      for (let n = 3; n <= 4; n++) {
        while (provider.requests.length < n) await h.session.step()
        h.session.preset.completionGate.contractReview = false
        h = await reopen(h)
        await h.session.resume()
        expect((await ran(h)).data).toEqual(budget)
      }
      expect((await run(h)).reason).toBe('blocked')
      expect(provider.requests).toHaveLength(5)
      const anchor = await ran(h)
      const intents = await h.log.scan({ type: 'effect/intent', fromSeq: anchor.seq, limit: 100 })
      expect(intents.filter((row) => (row.data as { kind: string }).kind === 'inference')).toHaveLength(3)
      expect(h.session.pendingEffects()).toEqual([])
    } finally {
      await h.session.close()
    }
  })

  it('refuses a recovered same-effect second dispatch after the original deadline', async () => {
    let now = 1_757_203_200_000
    let reads = 0
    const registry = new ToolRegistry()
    registry.add(writeTool(), { source: 'test', trust: 'builtin' })
    registry.add(
      readTool(async () => {
        reads++
        return { content: [] }
      }),
      { source: 'test', trust: 'builtin' },
    )
    let h = await atReview({
      registry,
      clock: () => now,
      provider: fakeProvider([
        toolTurn('write_note', {}),
        textTurn('candidate'),
        toolTurn('read', {}),
        textTurn('checked'),
      ]),
    })
    expect((await run(h)).reason).toBe('completed')
    const rows = await h.log.scan({ limit: 1000 })
    const reviewStart = (await ran(h)).seq
    const result = rows.find((row) => row.seq > reviewStart && row.type === 'tool/result')!
    const cells = h.opCellsBefore(result.seq)
    const prefix = rows.filter((row) => row.seq <= cells[0]!.seq)
    now += 60_000
    h = await reopen(h, {
      storage: MemoryStorage.fromEvents('k', prefix, { opCells: cells }),
      clock: () => now,
    })
    try {
      expect((await h.session.resume()).actions).toEqual([{ effectId: expect.any(String), action: 'error' }])
      expect((await run(h)).reason).toBe('blocked')
      expect(reads).toBe(1)
      expect(h.session.pendingEffects()).toEqual([])
      const intents = await h.log.scan({ type: 'effect/intent', fromSeq: reviewStart, limit: 100 })
      expect(intents.filter((row) => (row.data as { kind: string }).kind === 'tool')).toHaveLength(1)
      expect((await h.log.scan({ type: 'turn/end', limit: 10 }))[0]?.data).toMatchObject({
        error: { code: 'COMPLETION_REVIEW_TIME_LIMIT' },
      })
    } finally {
      await h.session.close()
    }
  })

  it.each(['before', 'after'] as const)(
    'keeps unknown effects parked across two cold opens and refuses expired reconciliation work (%s answer)',
    async (answerAt) => {
      let now = 1_757_203_200_000
      let writes = 0
      const registry = new ToolRegistry()
      registry.add(
        writeTool(async () => {
          if (++writes > 1) throw new Error('receipt lost')
          return { content: [{ type: 'text', text: 'written' }] }
        }),
        { source: 'test', trust: 'builtin' },
      )
      let h = await atReview({
        registry,
        clock: () => now,
        provider: fakeProvider([
          toolTurn('write_note', {}),
          textTurn('candidate'),
          toolTurn('write_note', {}),
          textTurn('must not dispatch'),
        ]),
      })
      expect((await run(h)).reason).toBe('parked')
      const anchor = (await ran(h)).data
      h = await reopen(h, { clock: () => now })
      h = await reopen(h, { clock: () => now })
      try {
        const q = (await h.session.decisions.list()).find(
          (q) => q.request.spec.purpose === 'unknown-outcome',
        )!
        if (answerAt === 'after') now += 60_000
        await h.session.decisions.answer(
          {
            handle: q.handle,
            revision: q.revision,
            commandId: 'reconcile',
            response: { option: 'allowed-once', value: null },
          },
          { actor, category: 'human', authorize() {} },
        )
        if (answerAt === 'before') now += 60_000
        expect((await run(h)).reason).toBe('blocked')
        expect(writes).toBe(2)
        expect((await ran(h)).data).toEqual(anchor)
        expect(await h.log.scan({ type: 'x/core/completion-review-anchor', limit: 10 })).toHaveLength(1)
        expect(
          (await h.log.scan({ type: 'effect/settled', limit: 100 })).some(
            (row) => (row.data as { outcome: string }).outcome === 'unknown',
          ),
        ).toBe(true)
        expect(h.session.pendingEffects()).toEqual([])
        expect((await h.session.decisions.get(q.handle)).consumption).toBeTruthy()
      } finally {
        await h.session.close()
      }
    },
  )
})
