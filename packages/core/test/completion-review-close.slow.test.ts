import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { LoopContext, LoopFactory } from '@agnes/extension-api'
import { defaultLoopFactory } from '@agnes/loop-default'
import { describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { defaultLoops } from '../testkit/loops.js'
import { input, preset } from './helpers/completion-review.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps, testWorkspaceInvocation, writeTool } from './helpers/open-session.js'

describe('completion review restart cleanup', () => {
  it.each(['closed', 'active'] as const)(
    'retains resumed driver ownership while the session is %s',
    async (mode) => {
      let now = 1_757_203_200_000
      let release: () => void = () => undefined
      let entered: () => void = () => undefined
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      let fresh: LoopContext | undefined
      let constructionSignal: AbortSignal | undefined
      const resource = new EventTarget()
      const resourceLifetime = new AbortController()
      let newWork = 0
      const performWork = () => {
        newWork++
      }
      const factory: LoopFactory = {
        ...defaultLoopFactory,
        id: 'test.review-close',
        async resume(ctx, checkpoint, signal) {
          const driver = await defaultLoopFactory.resume(ctx, checkpoint, signal)
          fresh = ctx
          constructionSignal = signal
          resource.addEventListener('work', performWork)
          entered()
          await barrier
          if (mode === 'active') await ctx.input.claim('next-turn')
          return {
            checkpoint: () => driver.checkpoint(),
            step: async (joined) => {
              newWork++
              return driver.step(joined)
            },
            cancel: async () => {
              resourceLifetime.abort()
              await driver.cancel()
            },
            dispose: async () => {
              resource.removeEventListener('work', performWork)
              await driver.dispose()
            },
          }
        },
      }
      const loops = defaultLoops()
      loops.register('@test/review-close', factory)
      const provider = fakeProvider([
        toolTurn('write_note', {}),
        textTurn('candidate'),
        textTurn('must not run'),
      ])
      const k = Kernel.create({
        storage: new MemoryStorage(),
        loops,
        provider,
        preset: preset(),
        operations: [
          {
            name: 'review',
            slot: 'before-inference',
            replay: 'safe',
            applicable: async () => 'applied',
            run: async () => ({}),
            completionReviewNote: () => 'Preserve final artifacts.',
          },
        ],
        seams: fakeSeams(),
        contract: { contract_id: null, parser_version: '1' },
        fsOps: testFsOps(),
        netFetch: async () => new Response(''),
        timers: noTimers,
        clock: () => now,
        closeDrainMs: 1,
      })
      k.tools.add(writeTool(), { source: 'test', trust: 'builtin' })
      const session = await k.session('review-close', {
        actor,
        resolvedProfileHash: null,
        cwd: '/w',
        writerRunId: 'writer',
        workspaceInvocation: testWorkspaceInvocation(),
        loop: factory,
      })
      let pending: Promise<unknown> | undefined
      try {
        await session.enqueue('next-turn', input)
        for (let n = 0; n < 20; n++) {
          const reviews = await session.scan({ type: 'x/core/completion-gate', limit: 20 })
          if (reviews.some((row) => (row.data as { status: string }).status === 'ran')) break
          await session.step()
        }
        expect(
          (await session.scan({ type: 'x/core/completion-gate', limit: 20 })).some(
            (row) => (row.data as { status: string }).status === 'ran',
          ),
        ).toBe(true)
        if (mode === 'active') await session.enqueue('next-turn', input)
        now += 60_000
        pending = session.run({ until: 'turn-end', signal: new AbortController().signal }).then(
          () => undefined,
          () => undefined,
        )
        await ready
        if (mode === 'active') {
          release()
          await pending
          expect(resourceLifetime.signal.aborted).toBe(false)
          await fresh?.events.emit('resumed', {})
          expect(await session.scan({ type: 'turn/start', limit: 10 })).toHaveLength(2)
          resource.dispatchEvent(new Event('work'))
          expect(newWork).toBe(1)
          await session.close()
          resource.dispatchEvent(new Event('work'))
          expect({ cancelled: resourceLifetime.signal.aborted, newWork }).toEqual({
            cancelled: true,
            newWork: 1,
          })
          expect(provider.requests).toHaveLength(2)
          return
        }
        const closing = session.close()
        await closing
        expect(constructionSignal?.aborted).toBe(true)
        expect(session.d.log.isClosed).toBe(true)
        const closedRows = await k.o.storage.scan(session.key, { fromSeq: 1, limit: 1000 })
        release()
        await pending
        resource.dispatchEvent(new Event('work'))
        expect({ cancelled: resourceLifetime.signal.aborted, newWork }).toEqual({
          cancelled: true,
          newWork: 0,
        })
        await expect(fresh?.events.emit('after-close', {})).rejects.toMatchObject({ code: 'E_CLOSED' })
        await expect(session.step()).rejects.toMatchObject({ code: 'E_CLOSED' })
        expect(session.close()).toBe(closing)
        expect(await k.o.storage.scan(session.key, { fromSeq: 1, limit: 1000 })).toEqual(closedRows)
        expect(provider.requests).toHaveLength(2)
      } finally {
        release()
        await pending
        await k.close()
      }
    },
  )
})
