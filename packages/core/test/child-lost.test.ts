import { presetDefaults } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { Provider, SystemInput } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import type { KernelChildren } from '../src/child/factory.js'
import { CHILD_LOST } from '../src/child/lost-children.js'
import { Kernel } from '../src/kernel.js'
import { defaultLoops } from '../testkit/loops.js'
import { hangingProvider, model, until } from './helpers/child-traces.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'

// The kernel's default writer lease. Timers never fire here, so no lease is renewed on its own.
const LEASE = 30_000
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w' }

function kernel(storage: MemoryStorage, provider: Provider, limits = { maxFanOut: 4, generationLimit: 1 }) {
  return Kernel.create({
    loops: defaultLoops(),
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits: 100, ...limits },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => 1_757_203_200_000,
  })
}

type Parent = Awaited<ReturnType<ReturnType<typeof kernel>['session']>>

function notices(parent: Parent): SystemInput[] {
  const inbox = parent.latest('inbox') as { items: Array<{ system?: SystemInput }> } | undefined
  return (inbox?.items ?? []).flatMap((item) =>
    item.system?.type === 'child-completed' ? [item.system] : [],
  )
}

const running = async (storage: MemoryStorage, key: string) =>
  until(
    async () =>
      (await storage.lookupByKey(key))?.state === 'running' &&
      (await storage.scan(key, { type: 'turn/start', limit: 1 })).length === 1,
  )

/**
 * A parent whose background child is mid-turn when its process exits: the first kernel is simply
 * abandoned, so nothing is closed, cancelled or renewed. The store clock is `clock.now`.
 */
async function crashed(opts: { limits?: { maxFanOut: number; generationLimit: number }; role?: true } = {}) {
  const clock = { now: 1_000_000 }
  const storage = new MemoryStorage({ clock: () => clock.now })
  const first = kernel(storage, hangingProvider(), opts.limits)
  const parent = await first.session('parent', { ...sessionOpts, writerRunId: 'first' })
  const child = await parent.d.children.createWithKind!('spawn', {
    parent: parent.key,
    cwd: '/w',
    input: 'work',
    parentEffectId: 'lost',
  })
  if (opts.role) {
    const session = first.get(child.key)!
    await session.d.log.append([
      session.ev(
        'x/core/role-delegation',
        { role: { ref: '@fixture/roles#reader', title: { en: 'Reader' } } },
        { register: 'x/core/role-delegation', ignorable: true },
      ),
    ])
  }
  void child.run('work').catch(() => undefined)
  expect(await running(storage, child.key)).toBe(true)
  return { clock, storage, first, parent, child }
}

/** The parent opened again by a new process over the same store. */
async function reopen(
  storage: MemoryStorage,
  provider: Provider = hangingProvider(),
  limits?: { maxFanOut: number; generationLimit: number },
) {
  const next = kernel(storage, provider, limits)
  return { next, parent: await next.session('parent', { ...sessionOpts, writerRunId: 'next' }) }
}

const spawn = (parent: Parent, effect: string) =>
  parent.d.children.createWithKind!('spawn', {
    parent: parent.key,
    cwd: '/w',
    input: effect,
    parentEffectId: effect,
  })

describe('a child whose process exited before it finished', () => {
  it('is settled as failed on the next run, the parent is told once, and its slot is free again', async () => {
    const limits = { maxFanOut: 1, generationLimit: 1 }
    const { clock, storage, child } = await crashed({ limits })
    clock.now += LEASE + 1
    const { next, parent } = await reopen(storage, hangingProvider(), limits)
    // The reopened parent is live again, so the left-behind record still holds the only slot.
    await expect(spawn(parent, 'too-early')).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })

    await parent.d.children.recover?.()
    expect((await storage.lookupByKey(child.key))?.state).toBe('failed')
    expect(notices(parent)).toMatchObject([
      { data: { childKey: child.key, status: 'failed', error: CHILD_LOST } },
    ])
    await expect(spawn(parent, 'after')).resolves.toBeDefined()

    await parent.d.children.recover?.()
    expect(notices(parent)).toHaveLength(1)
    await next.close().catch(() => undefined)
  })

  it('is settled at the start of an ordinary run of the parent', async () => {
    const { clock, storage, child } = await crashed()
    clock.now += LEASE + 1
    const { next, parent } = await reopen(
      storage,
      Object.assign(fakeProvider([textTurn('ok')]), { models: () => [model()] }),
    )
    await parent.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go on' }] })
    await parent.run({ until: 'turn-end', signal: new AbortController().signal })
    expect((await storage.lookupByKey(child.key))?.state).toBe('failed')
    expect(notices(parent)).toMatchObject([{ data: { childKey: child.key, status: 'failed' } }])
    await next.close().catch(() => undefined)
  })

  it('is left alone while its own session still holds a live lease, and settled on a later run', async () => {
    const { clock, storage, child } = await crashed()
    clock.now += LEASE + 1
    // Another process holds the child's session: its lease is live.
    await storage.open(child.key, { writerRunId: 'elsewhere', ttlMs: LEASE })
    const { next, parent } = await reopen(storage)
    await parent.d.children.recover?.()
    expect((await storage.lookupByKey(child.key))?.state).toBe('running')
    expect(notices(parent)).toEqual([])

    clock.now += LEASE + 1
    await parent.d.children.recover?.()
    expect((await storage.lookupByKey(child.key))?.state).toBe('failed')
    expect(notices(parent)).toHaveLength(1)
    await next.close().catch(() => undefined)
  })

  it('is not taken for lost while this process still has its handle, whatever its lease says', async () => {
    const { clock, storage, first, parent, child } = await crashed()
    // The process lives on (a machine that slept, say): the child's lease lapsed, its instance did not.
    clock.now += LEASE + 1
    await parent.d.children.recover?.()
    expect((await storage.lookupByKey(child.key))?.state).toBe('running')
    expect(notices(parent)).toEqual([])
    await first.close().catch(() => undefined)
  })

  it('is left to role recovery when it was opened for a role', async () => {
    const { clock, storage, child } = await crashed({ role: true })
    clock.now += LEASE + 1
    const { next, parent } = await reopen(storage)
    await parent.d.children.recover?.()
    expect((await storage.lookupByKey(child.key))?.state).toBe('running')
    expect(notices(parent)).toEqual([])
    await next.close().catch(() => undefined)
  })

  it('is left alone by a store that cannot settle it', async () => {
    const { clock, storage, child } = await crashed()
    clock.now += LEASE + 1
    Object.defineProperty(storage, 'listLostChildren', { value: undefined, configurable: true })
    const { next, parent } = await reopen(storage)
    await parent.d.children.recover?.()
    expect((await storage.lookupByKey(child.key))?.state).toBe('running')
    await next.close().catch(() => undefined)
  })

  it('is settled as cancelled when a cancel was under way', async () => {
    const { clock, storage, child } = await crashed()
    const row = (await storage.lookupByKey(child.key))!
    expect(await storage.casState(child.key, row.stateRevision, 'cancelling')).toBe(true)
    clock.now += LEASE + 1
    const { next, parent } = await reopen(storage)
    await parent.d.children.recover?.()
    expect((await storage.lookupByKey(child.key))?.state).toBe('cancelled')
    const [notice] = notices(parent)
    expect(notice).toMatchObject({ data: { childKey: child.key, status: 'cancelled' } })
    expect(notice?.data).not.toHaveProperty('error')
    await next.close().catch(() => undefined)
  })

  it('is left to the loop that started it, which can still adopt it', async () => {
    const clock = { now: 1_000_000 }
    const storage = new MemoryStorage({ clock: () => clock.now })
    const first = kernel(storage, hangingProvider())
    const parent = await first.session('parent', { ...sessionOpts, writerRunId: 'first' })
    const start = { task: 'loop work', invocationId: 'loop-1', cwd: '/w' }
    const { id } = await (parent.d.children as unknown as KernelChildren).startResident(start)
    expect(await running(storage, id)).toBe(true)
    clock.now += LEASE + 1
    const { next, parent: reopened } = await reopen(storage)
    await reopened.d.children.recover?.()
    expect((await storage.lookupByKey(id))?.state).toBe('running')
    expect(notices(reopened)).toEqual([])
    await expect((reopened.d.children as unknown as KernelChildren).adoptResident(start)).resolves.toEqual({
      id,
    })
    await next.close().catch(() => undefined)
  })

  it('never stops the parent run when settling fails', async () => {
    const { clock, storage, child } = await crashed()
    clock.now += LEASE + 1
    Object.defineProperty(storage, 'listLostChildren', {
      value: async () => {
        throw new Error('storage unavailable')
      },
      configurable: true,
    })
    const { next, parent } = await reopen(storage)
    await expect(parent.d.children.recover?.()).resolves.toBeUndefined()
    expect((await storage.lookupByKey(child.key))?.state).toBe('running')
    await next.close().catch(() => undefined)
  })

  it('waits for every descendant lease to lapse before settling a subtree', async () => {
    const limits = { maxFanOut: 4, generationLimit: 2 }
    const { clock, storage, first, child } = await crashed({ limits })
    const grandchild = await first.get(child.key)!.d.children.createWithKind!('spawn', {
      parent: child.key,
      cwd: '/w',
      input: 'deeper',
      parentEffectId: 'deeper',
    })
    void grandchild.run('deeper').catch(() => undefined)
    expect(await running(storage, grandchild.key)).toBe(true)
    clock.now += LEASE + 1
    // Each session's lease lapses on its own timer: the grandchild's still holds.
    await storage.open(grandchild.key, { writerRunId: 'late', ttlMs: LEASE })
    const { next, parent } = await reopen(storage, hangingProvider(), limits)
    await parent.d.children.recover?.()
    expect((await storage.lookupByKey(child.key))?.state).toBe('running')
    expect((await storage.lookupByKey(grandchild.key))?.state).toBe('running')
    expect(notices(parent)).toEqual([])
    clock.now += LEASE + 1
    await parent.d.children.recover?.()
    expect((await storage.lookupByKey(grandchild.key))?.state).toBe('failed')
    expect((await storage.lookupByKey(child.key))?.state).toBe('failed')
    expect(notices(parent)).toMatchObject([{ data: { childKey: child.key } }])
    await next.close().catch(() => undefined)
  })

  it('is settled by a parent that is itself a child, once that one runs again', async () => {
    const limits = { maxFanOut: 4, generationLimit: 2 }
    const { clock, storage, first, child } = await crashed({ limits })
    const grandchild = await first.get(child.key)!.d.children.createWithKind!('spawn', {
      parent: child.key,
      cwd: '/w',
      input: 'deeper',
      parentEffectId: 'deeper',
    })
    void grandchild.run('deeper').catch(() => undefined)
    expect(await running(storage, grandchild.key)).toBe(true)
    clock.now += LEASE + 1
    const next = kernel(storage, hangingProvider(), limits)
    const middle = await next.session(child.key, { ...sessionOpts, writerRunId: 'next' })
    await middle.d.children.recover?.()
    expect((await storage.lookupByKey(grandchild.key))?.state).toBe('failed')
    expect(notices(middle)).toMatchObject([{ data: { childKey: grandchild.key, error: CHILD_LOST } }])
    await next.close().catch(() => undefined)
  })

  it('leaves a subtree alone while one of its sessions is open in this process', async () => {
    const limits = { maxFanOut: 4, generationLimit: 2 }
    const { clock, storage, first, child } = await crashed({ limits })
    const grandchild = await first.get(child.key)!.d.children.createWithKind!('spawn', {
      parent: child.key,
      cwd: '/w',
      input: 'deeper',
      parentEffectId: 'deeper',
    })
    void grandchild.run('deeper').catch(() => undefined)
    expect(await running(storage, grandchild.key)).toBe(true)
    clock.now += LEASE + 1
    const { next, parent } = await reopen(storage, hangingProvider(), limits)
    // Someone in this process opened the grandchild's session; its lease lapses all the same.
    await next.session(grandchild.key, { ...sessionOpts, writerRunId: 'opened' })
    clock.now += LEASE + 1
    await parent.d.children.recover?.()
    expect((await storage.lookupByKey(child.key))?.state).toBe('running')
    expect((await storage.lookupByKey(grandchild.key))?.state).toBe('running')
    await next.close().catch(() => undefined)
  })

  it('takes its own children with it, telling only the parent that is still there', async () => {
    const limits = { maxFanOut: 4, generationLimit: 2 }
    const { clock, storage, first, child } = await crashed({ limits })
    const middle = first.get(child.key)!
    const grandchild = await middle.d.children.createWithKind!('spawn', {
      parent: child.key,
      cwd: '/w',
      input: 'deeper',
      parentEffectId: 'deeper',
    })
    void grandchild.run('deeper').catch(() => undefined)
    expect(await running(storage, grandchild.key)).toBe(true)
    clock.now += LEASE + 1
    const { next, parent } = await reopen(storage, hangingProvider(), limits)
    await parent.d.children.recover?.()
    expect((await storage.lookupByKey(child.key))?.state).toBe('failed')
    expect((await storage.lookupByKey(grandchild.key))?.state).toBe('failed')
    expect(notices(parent)).toMatchObject([{ data: { childKey: child.key } }])
    await next.close().catch(() => undefined)
  })
})
