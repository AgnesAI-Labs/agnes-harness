import { realpathSync } from 'node:fs'
import { Kernel, noopHooks, presetDefaults, type SessionImpl } from '@agnes/core'
import { actor, fakeProvider, fakeSeams, MemoryStorage, noTimers, testFsPolicy } from '@agnes/core/testkit'
import { afterEach, expect, it } from 'vitest'
import { createFs } from '../../src/adapters/fs.js'
import { ExtensionSessions } from '../../src/ext-host/session-bindings.js'

const kernels: Kernel[] = []
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.close()
})
function kernel(hooksFactory: NonNullable<Parameters<typeof Kernel.create>[0]['hooksFactory']>) {
  const k = Kernel.create({
    storage: new MemoryStorage(),
    seams: fakeSeams(),
    provider: fakeProvider([]),
    contract: { contract_id: null, parser_version: '1' },
    preset: presetDefaults(),
    fsOps: createFs(() => ({
      policy: testFsPolicy(realpathSync(process.cwd())),
      caseSensitive: true,
    })),
    netFetch: async () => new Response(''),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    timers: noTimers,
    hooksFactory,
  })
  kernels.push(k)
  return k
}
const opts = { actor, resolvedProfileHash: 'h', cwd: process.cwd(), writerRunId: 'run' }
it('binds actual startup before publication and retains identity through shutdown then removes it', async () => {
  const bindings = new ExtensionSessions(),
    seen: string[] = []
  let canonical: NonNullable<ReturnType<typeof bindings.ref>> | undefined
  const k = kernel(
    bindings.factory((session) => ({
      ...noopHooks,
      async sessionStart() {
        canonical = bindings.ref(session)
        expect(k.get(session.key)).toBeUndefined()
        expect(canonical).toBeDefined()
        expect(bindings.resolve(canonical as NonNullable<typeof canonical>)).toBe(session)
        expect(
          bindings.resolve({ key: session.key, lane: session.lane, workspaceRoot: session.d.cwd }),
        ).toBeUndefined()
        expect(
          bindings.resolve({ key: session.key, lane: 'wrong', workspaceRoot: session.d.cwd }),
        ).toBeUndefined()
        seen.push('start')
      },
      async shutdown() {
        expect(bindings.resolve(canonical as NonNullable<typeof canonical>)).toBe(session)
        seen.push('close')
      },
    })),
  )
  const session = await k.session('actual', opts)
  expect(bindings.entries().map((e) => e.session)).toEqual([session])
  await session.close()
  expect(bindings.entries()).toEqual([])
  expect(bindings.resolve(canonical as NonNullable<typeof canonical>)).toBeUndefined()
  expect(seen).toEqual(['start', 'close'])
})

it('never cross-binds simultaneous sessions whose descriptive key and lane are identical', async () => {
  const bindings = new ExtensionSessions()
  const make = bindings.factory(() => ({ ...noopHooks }))
  const first = { key: 'same', lane: 'main', d: { cwd: '/workspace' } } as SessionImpl
  const second = { key: 'same', lane: 'main', d: { cwd: '/workspace' } } as SessionImpl
  const firstPort = make(first)
  const secondPort = make(second)
  const firstRef = bindings.ref(first)
  const secondRef = bindings.ref(second)
  expect(firstRef).toBeDefined()
  expect(secondRef).toBeDefined()
  expect(firstRef).not.toBe(secondRef)
  expect(bindings.resolve(firstRef as NonNullable<typeof firstRef>)).toBe(first)
  expect(bindings.resolve(secondRef as NonNullable<typeof secondRef>)).toBe(second)
  expect(bindings.resolve({ key: 'same', lane: 'main', workspaceRoot: '/workspace' })).toBeUndefined()
  await firstPort.shutdown?.()
  expect(bindings.resolve(firstRef as NonNullable<typeof firstRef>)).toBeUndefined()
  expect(bindings.resolve(secondRef as NonNullable<typeof secondRef>)).toBe(second)
  await secondPort.shutdown?.()
})
it('removes a failed startup binding even when cleanup throws, then permits a fresh session', async () => {
  const bindings = new ExtensionSessions()
  let fail = true
  let failedRef: ReturnType<typeof bindings.ref>
  const k = kernel(
    bindings.factory((session) => ({
      ...noopHooks,
      async sessionStart() {
        if (fail) {
          failedRef = bindings.ref(session)
          throw new Error('start failed')
        }
      },
      async shutdown() {
        if (fail) throw new Error('cleanup failed')
      },
    })),
  )
  await expect(k.session('retry', opts)).rejects.toThrow('initialization and cleanup failed')
  expect(bindings.entries()).toEqual([])
  expect(k.get('retry')).toBeUndefined()
  expect(failedRef).toBeDefined()
  expect(bindings.resolve(failedRef as NonNullable<typeof failedRef>)).toBeUndefined()
  expect(bindings.isOpening(failedRef as NonNullable<typeof failedRef>)).toBe(false)
  fail = false
  const session = await k.session('retry', opts)
  expect(bindings.entries()[0]?.session).toBe(session)
})
it('does not mask reuse of an original hook port with fresh wrappers', async () => {
  const bindings = new ExtensionSessions(),
    shared = { ...noopHooks }
  const k = kernel(bindings.factory(() => shared))
  const first = await k.session('one', opts)
  await expect(k.session('two', opts)).rejects.toThrow('session hook port reused')
  expect(bindings.entries().map((e) => e.session)).toEqual([first])
  await first.close()
  await expect(k.session('three', opts)).rejects.toThrow('session hook port reused')
  expect(bindings.entries()).toEqual([])
})
it('does not retain invalid factory output and preserves class method receivers', async () => {
  const bindings = new ExtensionSessions()
  let invalid = true
  class Port {
    #calls = 0
    toolCall = noopHooks.toolCall
    turnStopping = noopHooks.turnStopping
    context = noopHooks.context
    beforeRequest = noopHooks.beforeRequest
    beforeStep = noopHooks.beforeStep
    async sessionStart() {
      this.#calls++
    }
    calls() {
      return this.#calls
    }
  }
  const port = new Port()
  const k = kernel(bindings.factory(() => (invalid ? ({} as SessionImpl['hooks']) : port)))
  await expect(k.session('invalid', opts)).rejects.toThrow('invalid session hook port')
  expect(bindings.entries()).toEqual([])
  invalid = false
  await k.session('valid', opts)
  expect(port.calls()).toBe(1)
})

it('supports frozen factory ports without bypassing startup or losing close cleanup', async () => {
  const bindings = new ExtensionSessions()
  const seen: string[] = []
  const port = Object.freeze({
    ...noopHooks,
    async sessionStart() {
      seen.push('start')
    },
    async shutdown() {
      seen.push('close')
    },
  })
  const k = kernel(bindings.factory(() => port))
  const session = await k.session('frozen', opts)
  expect(seen).toEqual(['start'])
  expect(bindings.entries()[0]?.session).toBe(session)
  await session.close()
  expect(seen).toEqual(['start', 'close'])
  expect(bindings.entries()).toEqual([])
  expect(Object.isFrozen(port)).toBe(true)
})
