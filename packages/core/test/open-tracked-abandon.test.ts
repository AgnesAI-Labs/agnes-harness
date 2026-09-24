import type { InferenceEvent, Provider } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { SessionLogImpl, type Timers } from '../src/log/session-log.js'
import { openTracked } from '../src/reduce/tracker.js'
import { presetDefaults } from '../src/step/preset.js'
import type { Event, EventInput } from '../src/types.js'
import { fakeProvider, sentFor, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, openSession, testFsOps } from './helpers/open-session.js'

/** A model that says it sent the request and never answers, so the turn stays in inference. */
const hanging = (): Provider => ({
  models: () => [],
  async *infer(req): AsyncIterable<InferenceEvent> {
    yield sentFor(req)
    await new Promise<void>(() => undefined)
  },
})

const user = (text: string): EventInput => ({
  actor: actor as Event['actor'],
  origin: 'principal',
  trust: 'trusted',
  type: 'user/message',
  data: { content: [{ type: 'text', text }] },
})

/** Timers that remember which callbacks are still armed, and how many were ever armed. */
function recordingTimers(): Timers & { armed: Set<number>; ever: () => number } {
  let next = 0
  const armed = new Set<number>()
  return {
    armed,
    ever: () => next,
    setTimeout: () => {
      armed.add(++next)
      return next as never
    },
    clearTimeout: (id) => {
      armed.delete(id as unknown as number)
    },
  }
}

/**
 * The same storage, except that reading the ledger fails once `broken.on` is set: the event scan at
 * once, and the verified read from its second page on.
 */
function breakable(storage: MemoryStorage) {
  const broken = { on: false, scans: 0 }
  const proxy = new Proxy(storage, {
    get(target, prop) {
      if (prop === 'scan' && broken.on)
        return async () => {
          broken.scans++
          throw new Error('disk gone')
        }
      if (prop === 'scanIntegrity' && broken.on)
        return async (key: string, q: { fromSeq: number; toSeq: number; limit: number }) => {
          if (q.fromSeq > 1 && !(q.limit === 1 && q.fromSeq === q.toSeq)) {
            broken.scans++
            throw new Error('disk gone')
          }
          return target.scanIntegrity(key, q)
        }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { storage: proxy, broken }
}

const openFor = (storage: MemoryStorage, writerRunId: string, timers: Timers = noTimers) =>
  openTracked({
    storage,
    key: 'k',
    writerRunId,
    ttlMs: 60_000,
    ids: defaultIds(),
    clock: () => 1_757_203_200_000,
    timers,
  })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('an open that fails after taking the lease', () => {
  it('hands the lease back at once when reading the ledger fails part-way, before renewal is armed', async () => {
    // A turn left open in inference: its program counter would keep the lease renewal armed on open.
    const memory = new MemoryStorage()
    const first = await openSession({ provider: hanging(), storage: memory })
    await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect(await first.session.step()).toEqual({ phase: 'checkpoint' })
    expect(await first.session.step()).toEqual({ phase: 'inference' })
    // Enough rows for a second verification page.
    await first.log.append(Array.from({ length: 600 }, (_, n) => user(`pad ${n}`)))
    await first.log.close()

    const { storage, broken } = breakable(memory)
    broken.on = true
    const timers = recordingTimers()
    await expect(openFor(storage, 'r1', timers)).rejects.toThrow('disk gone')
    expect(broken.scans).toBeGreaterThan(0)
    // The rows are folded while the open verifies them, so the failure lands inside the open itself:
    // the lease is given back there, before any renewal is armed.
    expect(timers.ever()).toBe(0)
    expect(timers.armed.size).toBe(0)

    const second = await openFor(memory, 'r2')
    expect(second.log.lastSeq).toBe(first.log.lastSeq)
    await second.log.close()
  })

  it('hands the lease back when the open fails after replaying to the head', async () => {
    const memory = new MemoryStorage()
    const first = await openFor(memory, 'r0')
    await first.log.append([user('one')])
    await first.log.close()
    const bare = await SessionLogImpl.open({
      storage: memory,
      key: 'k',
      writerRunId: 'r-bare',
      ttlMs: 60_000,
      ids: defaultIds(),
      clock: () => 1_757_203_200_000,
      timers: noTimers,
    })
    await bare.append([user('two')])
    await bare.close()

    const failing = openTracked({
      storage: memory,
      key: 'k',
      writerRunId: 'r1',
      ttlMs: 60_000,
      ids: defaultIds(),
      clock: () => 1_757_203_200_000,
      timers: noTimers,
      verify: 'sample',
      random: () => {
        throw new Error('no entropy')
      },
    })
    await expect(failing).rejects.toThrow('no entropy')
    await (await openFor(memory, 'r2')).log.close()
  })

  it('gives a forked writer back when its open fails after replay', async () => {
    const memory = new MemoryStorage()
    const k = Kernel.create({
      storage: memory,
      seams: fakeSeams(),
      provider: fakeProvider([textTurn('hi')]),
      contract: { contract_id: null, parser_version: '1' },
      preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 2 },
      fsOps: testFsOps(),
      netFetch: async () => new Response(''),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      timers: noTimers,
      clock: () => 1_757_203_200_000,
    })
    const opts = { actor, resolvedProfileHash: 'h1', cwd: '/w' }
    const parent = await k.session('parent', { ...opts, writerRunId: 'r1' })
    const registers = SessionLogImpl.prototype.allRegisters
    vi.spyOn(SessionLogImpl.prototype, 'allRegisters').mockImplementation(function (this: SessionLogImpl) {
      if (this.key === 'child') throw new Error('register table unreadable')
      return registers.call(this)
    })
    await expect(
      k.session('child', {
        ...opts,
        writerRunId: 'r2',
        parent: { key: 'parent', boundarySeq: parent.lastSeq },
      }),
    ).rejects.toThrow('register table unreadable')
    vi.restoreAllMocks()
    await k.close()
  })

  it('leaves a forked writer to the kernel, which closes it exactly once', async () => {
    const memory = new MemoryStorage()
    const { storage, broken } = breakable(memory)
    const k = Kernel.create({
      storage,
      seams: fakeSeams(),
      provider: fakeProvider([textTurn('hi')]),
      contract: { contract_id: null, parser_version: '1' },
      preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 2 },
      fsOps: testFsOps(),
      netFetch: async () => new Response(''),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      timers: noTimers,
      clock: () => 1_757_203_200_000,
    })
    const opts = { actor, resolvedProfileHash: 'h1', cwd: '/w' }
    const parent = await k.session('parent', { ...opts, writerRunId: 'r1' })
    const close = vi.spyOn(SessionLogImpl.prototype, 'close')
    const childCloses = () =>
      close.mock.contexts.filter((log) => (log as SessionLogImpl).key === 'child').length
    broken.on = true
    await expect(
      k.session('child', {
        ...opts,
        writerRunId: 'r2',
        parent: { key: 'parent', boundarySeq: parent.lastSeq },
      }),
    ).rejects.toThrow('disk gone')
    expect(childCloses()).toBe(1)
    broken.on = false
    await k.close()
  })
})
