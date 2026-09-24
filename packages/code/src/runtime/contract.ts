import { describe, expect, it } from 'vitest'
import type { CodeRuntime, RuntimeFactory } from './index.js'
import { deferred, settles } from './testkit-utils.js'

export type RuntimeVectors = {
  echo: string
  expectedOutput: string
  call: string
  expectedFrame: unknown
  /** Must enter the supplied bindings handler and remain running until it settles or is cancelled. */
  wait: string
  persistent?: { define: string; read: string; name: string; expectedOutput: string }
}
const log = { debug() {}, info() {}, warn() {}, error() {} }
const limits = { wallMs: 5000, maxOutputChars: 65536 }
const bindings = async () => ({ marker: 'bridge-contract-ok' })

/** Backend-supplied executable vectors prevent meaningless 'noop' errors from passing as execution. */
export function runtimeContract(name: string, factory: RuntimeFactory, vectors: RuntimeVectors): void {
  const withRuntime = async (body: (rt: CodeRuntime) => Promise<void>) => {
    const controller = new AbortController()
    const rt = await factory({ log, signal: controller.signal })
    try {
      await body(rt)
    } finally {
      controller.abort()
      await rt.kill()
    }
  }
  const start = (rt: CodeRuntime) => rt.start({ cwd: process.cwd(), env: {}, confine: async (argv) => argv })
  describe(`CodeRuntime contract: ${name}`, () => {
    it('declares supported descriptors and a successful versioned probe', () =>
      withRuntime(async (rt) => {
        expect(['python', 'typescript']).toContain(rt.language)
        expect(['persistent', 'stateless']).toContain(rt.state)
        expect(['process', 'worker-thread', 'container']).toContain(rt.isolation)
        const probe = await rt.probe()
        expect(probe.ok).toBe(true)
        if (probe.ok) expect(probe.version.length).toBeGreaterThan(0)
      }))
    it('routes startup through confine and refuses a denied launch', () =>
      withRuntime(async (rt) => {
        let calls = 0
        await expect(
          rt.start({
            cwd: process.cwd(),
            env: {},
            confine: async (argv) => {
              expect(argv.length).toBeGreaterThan(0)
              calls++
              throw new Error('contract launch denied')
            },
          }),
        ).rejects.toThrow()
        expect(calls).toBe(1)
        await expect(rt.run({ program: vectors.echo, bindings, limits })).rejects.toThrow()
      }))
    it('runs a successful program with the expected output', () =>
      withRuntime(async (rt) => {
        await start(rt)
        const result = await rt.run({ program: vectors.echo, bindings, limits })
        expect(result.status).toBe('ok')
        expect(result.stdout).toContain(vectors.expectedOutput)
        expect(typeof result.stderr).toBe('string')
        expect(Number.isFinite(result.durationMs) && result.durationMs >= 0).toBe(true)
        expect(result.subcalls).toBe(0)
      }))
    it('refuses execution before start', () =>
      withRuntime(async (rt) => {
        await expect(rt.run({ program: vectors.echo, bindings, limits })).rejects.toThrow()
      }))
    it('does not execute a pre-aborted run', () =>
      withRuntime(async (rt) => {
        await start(rt)
        const ac = new AbortController()
        ac.abort()
        let calls = 0
        expect(
          (
            await rt.run({
              program: vectors.call,
              limits,
              signal: ac.signal,
              bindings: async () => {
                calls++
                return null
              },
            })
          ).status,
        ).toBe('aborted')
        expect(calls).toBe(0)
      }))
    it('transports a real binding frame and response', () =>
      withRuntime(async (rt) => {
        await start(rt)
        const frames: unknown[] = []
        const result = await rt.run({
          program: vectors.call,
          limits,
          bindings: async (frame) => {
            frames.push(frame)
            return bindings()
          },
        })
        expect(frames).toEqual([vectors.expectedFrame])
        expect(result.status).toBe('ok')
        expect(result.stdout).toContain('bridge-contract-ok')
        expect(result.subcalls).toBe(1)
      }))
    for (const method of ['signal', 'interrupt', 'kill'] as const) {
      it(`settles an in-flight run after ${method}`, () =>
        withRuntime(async (rt) => {
          await start(rt)
          const entered = deferred<void>()
          const held = deferred<unknown>()
          const ac = new AbortController()
          const running = rt.run({
            program: vectors.wait,
            limits,
            signal: ac.signal,
            bindings: () => {
              entered.resolve(undefined)
              return held.promise
            },
          })
          try {
            await settles(entered.promise)
            if (method === 'signal') ac.abort()
            else await rt[method]()
            expect((await settles(running)).status).toBe('aborted')
          } finally {
            held.resolve(null)
          }
        }))
    }
    it('round-trips nonempty persistent values into a fresh runtime', () =>
      withRuntime(async (rt) => {
        if (rt.state === 'stateless') {
          expect(rt.snapshot).toBeUndefined()
          expect(rt.restore).toBeUndefined()
          expect(rt.listNames).toBeUndefined()
          return
        }
        const vector = vectors.persistent
        if (!vector || !rt.snapshot || !rt.listNames)
          throw new Error('persistent runtime requires state vectors and methods')
        await start(rt)
        expect((await rt.run({ program: vector.define, bindings, limits })).status).toBe('ok')
        const names = await rt.listNames()
        expect(names.map((v) => v.name)).toContain(vector.name)
        for (const value of names) {
          expect(value.type.length).toBeGreaterThan(0)
          expect(Number.isFinite(value.bytes) && value.bytes >= 0).toBe(true)
        }
        const snapshot = await rt.snapshot()
        expect(snapshot.saved).toContain(vector.name)
        expect(snapshot.payload.byteLength).toBeGreaterThan(0)
        await withRuntime(async (fresh) => {
          await start(fresh)
          if (!fresh.restore) throw new Error('missing restore')
          expect((await fresh.restore(snapshot.payload)).restored).toContain(vector.name)
          const result = await fresh.run({ program: vector.read, bindings, limits })
          expect(result.status).toBe('ok')
          expect(result.stdout).toContain(vector.expectedOutput)
        })
      }))
    it('closes idempotently and refuses further execution', () =>
      withRuntime(async (rt) => {
        await start(rt)
        await rt.shutdown({ timeoutMs: 1000 })
        await rt.kill()
        await rt.kill()
        await expect(rt.run({ program: vectors.echo, bindings, limits })).rejects.toThrow()
      }))
    it('can interrupt an idle runtime', () =>
      withRuntime(async (rt) => {
        await rt.interrupt()
        await start(rt)
        await rt.interrupt()
        expect((await rt.run({ program: vectors.echo, bindings, limits })).status).toBe('ok')
      }))
  })
}
