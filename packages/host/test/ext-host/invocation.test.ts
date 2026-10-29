import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectionRegistry } from '@agnes/core'
import { createExtensionActivationBarrier } from '@agnes/host-extensions/ext-host/activation-barrier'
import { ExtensionInvocation } from '@agnes/host-extensions/ext-host/invocation'
import { afterEach, expect, it } from 'vitest'
import { createTestHost, type TestHost } from '../../testkit/index.js'

const held: Array<{ dir: string; testHost: TestHost }> = []
afterEach(async () => {
  for (const { dir, testHost } of held.splice(0)) {
    await testHost.host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-invocation-'))
  const testHost = await createTestHost({ dataDir: dir })
  held.push({ dir, testHost })
  const a = await testHost.host.createSession({ cwd: dir, key: 'a' })
  const b = await testHost.host.createSession({ cwd: dir, key: 'b' })
  return { a, b, scope: new ExtensionInvocation() }
}
const meta = { source: 'fixture/invocation', trust: 'trusted' as const }
const type = 'x/fixture/invocation/note'

it('binds interleaved async callbacks to their actual assembled session ledgers', async () => {
  const { a, b, scope } = await setup()
  let release: () => void = () => undefined
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = scope.run(a, a.ac.signal, async () => {
    await barrier
    await scope.append(type, { session: 'a' }, meta)
  })
  await scope.run(b, b.ac.signal, async () => {
    await scope.append(type, { session: 'b' }, meta)
    release()
  })
  await first
  expect((await a.scan({ type, toSeq: a.lastSeq })).map((row) => row.data)).toEqual([{ session: 'a' }])
  expect((await b.scan({ type, toSeq: b.lastSeq })).map((row) => row.data)).toEqual([{ session: 'b' }])
})

it.each([undefined, { ok: true }])(
  'closes a synchronous callback before its queued microtask: %j',
  async (result) => {
    const { a, scope } = await setup()
    let outcome = 'not-run'
    scope.run(a, a.ac.signal, () => {
      queueMicrotask(() => {
        try {
          void scope.append(type, {}, meta)
          outcome = 'allowed'
        } catch {
          outcome = 'refused'
        }
      })
      return result
    })
    await Promise.resolve()
    expect(outcome).toBe('refused')
    expect(await a.scan({ type, toSeq: a.lastSeq })).toEqual([])
  },
)

it('restores nested caller context and rejects appends outside any invocation', async () => {
  const { a, b, scope } = await setup()
  expect(() => scope.append(type, {}, meta)).toThrow('no active session')
  expect(() => scope.assertActive(meta.source)).toThrow('no active session')
  await scope.run(
    a,
    a.ac.signal,
    () => {
      expect(() => scope.assertActive(meta.source)).not.toThrow()
      expect(() => scope.assertActive('fixture/other')).toThrow('no active session')
    },
    meta.source,
  )
  await scope.run(a, a.ac.signal, async () => {
    await scope.run(b, b.ac.signal, () => scope.append(type, { nested: true }, meta))
    await scope.append(type, { nested: false }, meta)
  })
  expect((await a.scan({ type, toSeq: a.lastSeq })).map((row) => row.data)).toEqual([{ nested: false }])
  expect((await b.scan({ type, toSeq: b.lastSeq })).map((row) => row.data)).toEqual([{ nested: true }])
  expect(() => scope.append(type, {}, meta)).toThrow('no active session')
})

it('rejects cancelled and late callbacks even when their async context still exists', async () => {
  const { a, scope } = await setup(),
    controller = new AbortController()
  let late: (() => void) | undefined
  // A timer retains the AsyncLocalStorage context, unlike a plain function returned to the caller.
  let release: () => void = () => undefined
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = scope.run(
    a,
    controller.signal,
    async () => {
      await barrier
      expect(() => scope.append(type, {}, meta)).toThrow('no active session')
      expect(() => scope.assertActive(meta.source)).toThrow('no active session')
    },
    meta.source,
  )
  controller.abort()
  release()
  await pending
  expect(() => scope.run(a, controller.signal, () => undefined)).toThrow('cancelled')
  const lateResult = new Promise<void>((resolve, reject) => {
    late = () => {
      try {
        expect(() => scope.append(type, {}, meta)).toThrow('no active session')
        expect(() => scope.assertActive(meta.source)).toThrow('no active session')
        resolve()
      } catch (error) {
        reject(error)
      }
    }
  })
  await scope.run(
    a,
    a.ac.signal,
    async () => {
      setTimeout(() => late?.(), 0)
    },
    meta.source,
  )
  await lateResult
  expect(await a.scan({ type, toSeq: a.lastSeq })).toEqual([])
})

it('reads a thenable once and maps ledger errors to fixed author-facing errors', async () => {
  const { a, scope } = await setup()
  let reads = 0
  const result = scope.run(a, a.ac.signal, () => ({
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable single-read boundary fixture
    get then() {
      reads++
      return (resolve: (value: number) => void) => {
        resolve(7)
      }
    },
  }))
  expect(await result).toBe(7)
  expect(reads).toBe(1)
  await a.close()
  await expect(
    scope.run(a, new AbortController().signal, () => scope.append(type, {}, meta)),
  ).rejects.toMatchObject({
    code: 'E_EVENT_NAMESPACE',
    message: 'E_EVENT_NAMESPACE: extension event write failed',
  })
})

it('keeps direct extension callbacks inside the activation quiescence boundary', async () => {
  const { a } = await setup()
  const barrier = createExtensionActivationBarrier()
  const scope = new ExtensionInvocation(barrier)
  let startTool: () => void = () => undefined
  const start = new Promise<void>((resolve) => {
    startTool = resolve
  })
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const turn = barrier.admit('turn')
  const callback = turn.run(async () => {
    await start
    return scope.run(a, a.ac.signal, () => held)
  })
  let switched = false
  const activation = barrier.quiesce('extension-cutover', async () => {
    switched = true
  })
  startTool()
  await Promise.resolve()
  expect(switched).toBe(false)
  expect(() => scope.run(a, a.ac.signal, () => undefined)).toThrow('activation-in-progress')
  release()
  await Promise.all([callback, activation])
  expect(switched).toBe(true)
})

const key = `${meta.source}/count`
const counting = () => ({
  key,
  stateVersion: 1,
  init: () => ({ notes: 0, lastSeq: 0 }),
  apply: (state: { notes: number; lastSeq: number }, event: { type: string; seq: number }) => ({
    notes: state.notes + (event.type === type ? 1 : 0),
    lastSeq: event.seq,
  }),
})
/** A projection reader over one real session, counting the ledger rows each read takes. */
function projectionReads(session: Awaited<ReturnType<typeof setup>>['a'], scope: ExtensionInvocation) {
  const scan = session.scan.bind(session)
  let rows = 0,
    calls = 0
  session.scan = async (query) => {
    const page = await scan(query)
    rows += page.length
    calls++
    return page
  }
  const read = async (registry: ProjectionRegistry) => {
    rows = 0
    calls = 0
    const result = await scope.run(
      session,
      session.ac.signal,
      () => scope.readProjection(registry, key, meta, () => undefined),
      meta.source,
    )
    return { ...result, rows, calls }
  }
  return {
    read,
    /** What a registry with no cache line reads at the same seq. */
    fresh: async () => {
      const registry = new ProjectionRegistry()
      registry.register(counting(), { owner: meta.source })
      return read(registry)
    },
    append: async (count: number) => {
      for (let n = 0; n < count; n++)
        await scope.run(session, session.ac.signal, () => scope.append(type, { n }, meta))
    },
  }
}

it('folds a projection over every row of a session longer than one scan page, then only new rows', async () => {
  const { a, scope } = await setup()
  const reads = projectionReads(a, scope)
  // Extension events outside a turn carry no per-turn quota, so they fill the SQLite ledger quickly.
  await reads.append(1_234)
  const registry = new ProjectionRegistry()
  registry.register(counting(), { owner: meta.source })
  const first = await reads.read(registry)
  expect(first.asOfSeq).toBe(a.lastSeq)
  expect(first.unit).toMatchObject({ state: { notes: 1_234, lastSeq: a.lastSeq } })
  expect(first.rows).toBe(a.lastSeq)
  await reads.append(7)
  const next = await reads.read(registry)
  const full = await reads.fresh()
  expect(next.rows).toBe(7)
  expect({ asOfSeq: next.asOfSeq, unit: next.unit }).toEqual({ asOfSeq: full.asOfSeq, unit: full.unit })
  expect(next.unit).toMatchObject({ state: { notes: 1_241, lastSeq: a.lastSeq } })
  const idle = await reads.read(registry)
  expect({ rows: idle.rows, calls: idle.calls }).toEqual({ rows: 0, calls: 0 })
  expect(idle.unit).toEqual(full.unit)
  await reads.append(1)
  const single = await reads.read(registry)
  expect(single.rows).toBe(1)
  expect(single.unit).toEqual((await reads.fresh()).unit)
  expect(single.unit).toMatchObject({ state: { notes: 1_242, lastSeq: a.lastSeq } })
}, 60_000)

it.each(['dropped', 'advanced'] as const)(
  'reads from the first row when the cached line is %s while the newer rows are read',
  async (race) => {
    const { a, scope } = await setup()
    const reads = projectionReads(a, scope)
    await reads.append(20)
    const registry = new ProjectionRegistry()
    let dispose = registry.register(counting(), { owner: meta.source })
    await reads.read(registry)
    await reads.append(5)
    const scan = a.scan.bind(a)
    let raced = false
    a.scan = async (query) => {
      if (!raced && (query.fromSeq ?? 1) > 1) {
        raced = true
        if (race === 'dropped') {
          // A reload registers the projection again; its new entry has no line yet.
          dispose()
          dispose = registry.register(counting(), { owner: meta.source })
        } else {
          // A concurrent read of newer rows moves the line past this read's cut.
          await reads.append(3)
          await reads.read(registry)
        }
      }
      return scan(query)
    }
    const read = await reads.read(registry)
    expect(raced).toBe(true)
    expect(read.unit).toEqual({ state: { notes: 25, lastSeq: read.asOfSeq }, stateVersion: 1 })
    expect(read.asOfSeq).toBe(race === 'dropped' ? a.lastSeq : a.lastSeq - 3)
    expect(registry.cacheLine(a.key, key)).toMatchObject({ seq: read.asOfSeq })
  },
)
