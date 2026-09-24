import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectionRegistry } from '@agnes/core'
import { afterEach, expect, it } from 'vitest'
import { createExtensionActivationBarrier } from '../../src/ext-host/activation-barrier.js'
import { ExtensionInvocation } from '../../src/ext-host/invocation.js'
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
  const pending = scope.run(a, controller.signal, async () => {
    await barrier
    expect(() => scope.append(type, {}, meta)).toThrow('no active session')
  })
  controller.abort()
  release()
  await pending
  expect(() => scope.run(a, controller.signal, () => undefined)).toThrow('cancelled')
  const lateResult = new Promise<void>((resolve, reject) => {
    late = () => {
      try {
        expect(() => scope.append(type, {}, meta)).toThrow('no active session')
        resolve()
      } catch (error) {
        reject(error)
      }
    }
  })
  await scope.run(a, a.ac.signal, async () => {
    setTimeout(() => late?.(), 0)
  })
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

it('folds a projection over every row of a session longer than one scan page', async () => {
  const { a, scope } = await setup()
  // Extension events outside a turn carry no per-turn quota, so they fill the SQLite ledger quickly.
  for (let n = 0; n < 1_234; n++) await scope.run(a, a.ac.signal, () => scope.append(type, { n }, meta))
  const registry = new ProjectionRegistry()
  registry.register(
    {
      key: `${meta.source}/count`,
      stateVersion: 1,
      init: () => ({ notes: 0, lastSeq: 0 }),
      apply: (state: { notes: number; lastSeq: number }, event) => ({
        notes: state.notes + (event.type === type ? 1 : 0),
        lastSeq: event.seq,
      }),
    },
    { owner: meta.source },
  )
  const { asOfSeq, unit } = await scope.run(
    a,
    a.ac.signal,
    () => scope.readProjection(registry, `${meta.source}/count`, meta, () => undefined),
    meta.source,
  )
  expect(asOfSeq).toBe(a.lastSeq)
  expect(unit).toMatchObject({ state: { notes: 1_234, lastSeq: a.lastSeq } })
}, 60_000)
