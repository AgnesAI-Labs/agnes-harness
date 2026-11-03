import { presetDefaults } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { expect, it, vi } from 'vitest'
import { retireIdleChildren } from '../src/child/idle-retirement.js'
import { Kernel } from '../src/kernel.js'
import { claimMaintenance } from '../src/maintenance/in-flight.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'

const HOUR = 3_600_000
async function fixture() {
  let now = 10_000
  const storage = new MemoryStorage()
  const provider = Object.assign(fakeProvider(Array.from({ length: 8 }, () => textTurn('saved answer'))), {
    models: () => [
      {
        id: 'm1',
        name: 'm1',
        api: 'openai-completions' as const,
        route: 'default',
        baseUrl: 'https://example.invalid/v1',
        reasoning: false,
        input: ['text' as const],
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 128,
        toolCallFormats: ['native' as const],
        thinkingReplay: 'native' as const,
        contract_id: null,
      },
    ],
  })
  const k = Kernel.create({
    storage,
    provider,
    loops: defaultLoops(),
    seams: fakeSeams(),
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 3, maxFanOut: 8 },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    timers: noTimers,
    clock: () => now,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
  const parent = await k.session('parent', { actor, cwd: '/w', writerRunId: 'r1', resolvedProfileHash: 'h1' })
  const spawn = async (owner = parent, input = 'work') => {
    const handle = await owner.d.children.create({ parent: owner.key, cwd: '/w', input, resident: true })
    await handle.run(input)
    const session = k.get(handle.key)
    if (!session) throw new Error('child missing')
    return { handle, session }
  }
  const sweep = (over: Partial<Parameters<typeof retireIdleChildren>[1]> = {}) =>
    retireIdleChildren(k, {
      now,
      idleMs: HOUR,
      limit: 50,
      signal: new AbortController().signal,
      canRetireSession: () => true,
      ...over,
    })
  return {
    k,
    storage,
    parent,
    spawn,
    sweep,
    advance: (ms: number) => {
      now += ms
    },
  }
}

it('retires only after a full idle hour, releases the writer and retains the completed output', async () => {
  const f = await fixture()
  try {
    const { handle, session } = await f.spawn()
    f.advance(HOUR - 1)
    expect(await f.sweep()).toEqual([])
    expect(f.k.get(handle.key)).toBe(session)
    f.advance(1)
    expect(await f.sweep()).toEqual([{ childKey: handle.key, status: 'retired' }])
    expect(f.k.sessions.has(handle.key)).toBe(false)
    expect(session.d.log.isClosed).toBe(true)
    expect(await f.parent.d.children.list?.()).toEqual([
      expect.objectContaining({ status: 'completed', continuable: false }),
    ])
    expect(await f.parent.d.children.inspect?.(handle.key)).toMatchObject({
      state: 'done',
      text: 'saved answer',
    })
    await expect(
      f.parent.d.children.sendMessage?.(handle.key, 'late', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    await f.storage.open(handle.key, { writerRunId: 'after-retirement', ttlMs: 1000 })
    await f.storage.release(handle.key, 'after-retirement')
    expect(await f.sweep()).toEqual([])
  } finally {
    await f.k.close()
  }
})

it('starts a new idle interval after continuation while reading and collecting do not extend it', async () => {
  const f = await fixture()
  try {
    const { handle } = await f.spawn()
    f.advance(HOUR - 1)
    await handle.run('follow-up')
    f.advance(HOUR - 1)
    const result = await f.parent.d.children.inspect?.(handle.key)
    if (!result?.completionId) throw new Error('completion missing')
    await f.parent.d.children.collected?.(handle.key, result.completionId, result.completionSeq ?? 0)
    expect(await f.sweep()).toEqual([])
    f.advance(1)
    expect(await f.sweep()).toEqual([{ childKey: handle.key, status: 'retired' }])
  } finally {
    await f.k.close()
  }
})

it.each(['host', 'inbox', 'maintenance', 'decision', 'operation'] as const)(
  'skips idle children with %s work',
  async (kind) => {
    const f = await fixture()
    let release = () => {}
    try {
      const { handle, session } = await f.spawn()
      f.advance(HOUR)
      if (kind === 'maintenance') {
        const maintenance = claimMaintenance(session, 'maintenance', () => {})
        if (typeof maintenance !== 'object') throw new Error('maintenance admission refused')
        release = maintenance.release
      }
      if (kind === 'operation') release = session.beginLoopOperation()
      if (kind === 'decision') {
        const source = session.decisions.port({
          owner: 'test',
          sourcePackage: '@test/idle',
          packageVersion: '1',
          operationId: 'review',
          alive() {},
        })
        await source.request({
          key: 'approval',
          purpose: 'business.confirm',
          subject: { revision: 0 },
          prompt: 'Continue?',
          options: ['allowed-once', 'rejected'],
          presentation: { en: { title: 'Review', fields: [], responseValue: 'Confirm' } },
          responseSchema: { type: 'string', enum: ['Confirm'] },
        })
      }
      if (kind === 'inbox')
        await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'queued' }] })
      expect(await f.sweep({ canRetireSession: () => kind !== 'host' })).toEqual([])
      expect((await f.storage.lookupByKey(handle.key))?.state).toBe('idle')
    } finally {
      release()
      await f.k.close()
    }
  },
)

it('does not retire an ancestor with a nonterminal descendant and observes the batch limit', async () => {
  const f = await fixture()
  try {
    const child = await f.spawn()
    const grandchild = await f.spawn(child.session, 'grandchild')
    f.advance(HOUR)
    expect(await f.sweep({ limit: 1 })).toEqual([{ childKey: grandchild.handle.key, status: 'retired' }])
    expect(f.k.sessions.has(child.handle.key)).toBe(true)
    expect(await f.sweep()).toEqual([{ childKey: child.handle.key, status: 'retired' }])
  } finally {
    await f.k.close()
  }
})

it('does not accept a continuation after retirement wins its state CAS', async () => {
  const f = await fixture()
  try {
    const { handle } = await f.spawn()
    f.advance(HOUR)
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const cas = f.storage.casState.bind(f.storage)
    vi.spyOn(f.storage, 'casState').mockImplementation(async (key, revision, next, admission) => {
      const result = await cas(key, revision, next, admission)
      if (key === handle.key && next === 'completed') {
        entered()
        await held
      }
      return result
    })
    const retiring = f.sweep()
    await reached
    const sending = f.parent.d.children.sendMessage!(
      handle.key,
      'must not vanish',
      new AbortController().signal,
    )
    const rejected = expect(sending).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    release()
    expect(await retiring).toEqual([{ childKey: handle.key, status: 'retired' }])
    await rejected
  } finally {
    await f.k.close()
  }
})

it('keeps a continuation that wins admission and resets its idle interval', async () => {
  const f = await fixture()
  try {
    const { handle } = await f.spawn()
    f.advance(HOUR)
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const cas = f.storage.casState.bind(f.storage)
    vi.spyOn(f.storage, 'casState').mockImplementation(async (key, revision, next, admission) => {
      const result = await cas(key, revision, next, admission)
      if (key === handle.key && next === 'ready') {
        entered()
        await held
      }
      return result
    })
    const sending = f.parent.d.children.sendMessage!(
      handle.key,
      'accepted follow-up',
      new AbortController().signal,
    )
    await reached
    const retiring = f.sweep()
    release()
    await sending
    expect(await retiring).toEqual([])
    await expect.poll(async () => (await f.storage.lookupByKey(handle.key))?.state).toBe('idle')
    expect(await f.sweep()).toEqual([])
    f.advance(HOUR)
    expect(await f.sweep()).toEqual([{ childKey: handle.key, status: 'retired' }])
  } finally {
    await f.k.close()
  }
})

it('reports cleanup failure without losing terminal output or retiring its ancestor', async () => {
  const f = await fixture()
  let expectedFailure = false
  try {
    const child = await f.spawn()
    const grandchild = await f.spawn(child.session, 'grandchild')
    grandchild.session.hooks.shutdown = async () => {
      throw new Error('private cleanup detail')
    }
    f.advance(HOUR)
    expect(await f.sweep()).toEqual([
      { childKey: grandchild.handle.key, status: 'failed', error: 'E_CHILD_RETIREMENT_CLEANUP' },
    ])
    expectedFailure = true
    expect((await f.storage.lookupByKey(grandchild.handle.key))?.state).toBe('completed')
    expect(await child.session.d.children.inspect?.(grandchild.handle.key)).toMatchObject({
      text: 'saved answer',
    })
    expect((await f.storage.lookupByKey(child.handle.key))?.state).toBe('idle')
    expect(await f.sweep()).toEqual([
      { childKey: grandchild.handle.key, status: 'failed', error: 'E_CHILD_RETIREMENT_CLEANUP' },
    ])
  } finally {
    if (expectedFailure) await expect(f.k.close()).rejects.toThrow()
    else await f.k.close()
  }
})

it('waits for a terminal nonresident descendant to release its resources', async () => {
  const f = await fixture()
  let release = () => {}
  try {
    const child = await f.spawn()
    const grandchild = await child.session.d.children.create({
      parent: child.handle.key,
      cwd: '/w',
      input: 'one-shot',
    })
    const session = f.k.get(grandchild.key)
    if (!session) throw new Error('grandchild missing')
    let entered!: () => void
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    session.hooks.shutdown = async () => {
      entered()
      await held
    }
    const running = grandchild.run('one-shot')
    await reached
    expect((await f.storage.lookupByKey(grandchild.key))?.state).toBe('completed')
    f.advance(HOUR)
    expect(await f.sweep()).toEqual([])
    release()
    await running
    expect(await f.sweep()).toEqual([{ childKey: child.handle.key, status: 'retired' }])
  } finally {
    release()
    await f.k.close()
  }
})

it.each(['fork', 'spawn'] as const)(
  'releases an unstarted %s descendant only after direct handle.close finishes',
  async (kind) => {
    const f = await fixture()
    let resolveHeld!: () => void
    const held = new Promise<void>((resolve) => {
      resolveHeld = resolve
    })
    let resolveReached!: () => void
    const reached = new Promise<void>((resolve) => {
      resolveReached = resolve
    })
    try {
      const child = await f.spawn()
      const grandchild = await child.session.d.children.createWithKind!(kind, {
        parent: child.handle.key,
        cwd: '/w',
        input: 'unstarted',
      })
      const session = f.k.get(grandchild.key)
      if (!session) throw new Error('grandchild missing')
      session.hooks.shutdown = async () => {
        resolveReached()
        await held
      }
      const closing = grandchild.close()
      await reached
      // Simulate durable revocation completing while this instance still owns its close drain.
      const record = await f.storage.lookupByKey(grandchild.key)
      if (!record) throw new Error('grandchild record missing')
      expect(record.state).toBe(kind === 'spawn' ? 'recovery_pending' : 'ready')
      expect(await f.storage.casState(grandchild.key, record.stateRevision, 'cancelled')).toBe(true)
      f.advance(HOUR)
      expect(session.d.log.isClosed).toBe(false)
      expect(await f.sweep()).toEqual([])
      resolveHeld()
      await closing
      expect(session.d.log.isClosed).toBe(true)
      expect(f.k.get(grandchild.key)).toBeUndefined()
      expect(await f.sweep()).toEqual([{ childKey: child.handle.key, status: 'retired' }])
    } finally {
      resolveHeld()
      await f.k.close()
    }
  },
)

it.each(['ready', 'running', 'waiting_approval', 'interrupted', 'recovery_pending'] as const)(
  'does not mistake a resident in durable %s state for idle',
  async (state) => {
    const f = await fixture()
    try {
      const { handle } = await f.spawn()
      const record = await f.storage.lookupByKey(handle.key)
      if (!record) throw new Error('child missing')
      expect(await f.storage.casState(handle.key, record.stateRevision, state, { maxFanOut: 8 })).toBe(true)
      f.advance(HOUR)
      expect(await f.sweep()).toEqual([])
      expect((await f.storage.lookupByKey(handle.key))?.state).toBe(state)
    } finally {
      await f.k.close()
    }
  },
)

it('does not retire when disabled or cancelled, and isolates each concrete kernel', async () => {
  const first = await fixture()
  const second = await fixture()
  try {
    const child = await first.spawn()
    const other = await second.spawn()
    first.advance(HOUR)
    expect(await first.sweep({ idleMs: 0 })).toEqual([])
    expect(await first.sweep({ signal: AbortSignal.abort() })).toEqual([])
    expect(await first.sweep()).toEqual([{ childKey: child.handle.key, status: 'retired' }])
    expect(second.k.get(other.handle.key)).toBe(other.session)
  } finally {
    await first.k.close()
    await second.k.close()
  }
})
