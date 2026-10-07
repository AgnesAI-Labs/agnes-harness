import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@agnes/cordis'
import {
  type ChildAgentResult,
  type KindMap,
  type LoopContext,
  type LoopDriver,
  type LoopFactory,
  loopCheckpointCodec,
  type PersistenceSessionStore,
} from '@agnes/extension-api'
import {
  childAgentConformance,
  loopConformance,
  persistenceConformance,
  sandboxConformance,
} from '@agnes/extension-api/testkit'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { expect, it } from 'vitest'
import { sqlitePersistenceProvider } from '../../src/adapters/index.js'
import { createTestHost } from '../../testkit/index.js'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}
async function fixture(dataDir: string, apply?: (ctx: Context) => void) {
  let context!: Context
  const { host } = await createTestHost({
    dataDir,
    script: [],
    disableSessionTitle: true,
    packages: {
      '@agnes/code': {
        plugins: [
          {
            declaration: {
              id: 'providers:owned-conformance',
              export: 'main',
              apiRange: '^1.4.0',
              runtime: 'in-process',
              default: true,
              inject: ['providers', 'childAgents', 'sandboxProviders', 'loops'],
            },
            entry: normalizePluginExport({
              inject: ['providers', 'childAgents', 'sandboxProviders', 'loops'],
              apply(ctx: Context) {
                context = ctx
                apply?.(ctx)
              },
            }),
          },
        ],
      },
    },
  })
  return { host, context }
}

it('verifies child-agent cancellation and handle drain through a real Host parent facade', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-child-conformance-'))
  const { host, context } = await fixture(dataDir)
  let ready = deferred()
  const resources = new Set<string>()
  const capabilities = {
    continuable: false,
    interrupt: false,
    modelSelection: false,
    inheritsParentContext: false,
    worktree: false,
  }
  const provider: KindMap['child-agent'] = {
    id: 'conformance-child',
    version: '1.0.0',
    capabilities,
    async start(_task, options) {
      const id = crypto.randomUUID()
      resources.add(id)
      const result = aborted(options.signal).then<ChildAgentResult>(() => ({ status: 'cancelled', text: '' }))
      return {
        id,
        providerId: provider.id,
        capabilities,
        async *events() {},
        async sendMessage() {
          return { messageId: 'unused' }
        },
        async interrupt() {
          return { accepted: false }
        },
        result() {
          ready.resolve()
          return result
        },
        async dispose() {
          await result
          resources.delete(id)
        },
      }
    },
  }
  const parent = context.childAgents.forSession({
    sessionKey: 'conformance-parent',
    cwd: dataDir,
    signal: new AbortController().signal,
  })
  try {
    expect(
      await childAgentConformance({
        providers: context.providers,
        sourcePackage: '@agnes/code',
        provider,
        async open() {
          return {
            start(signal) {
              ready = deferred()
              return {
                ready: ready.promise,
                result: parent
                  .start('controlled task', { providerId: provider.id, signal })
                  .then((handle) => handle.result()),
              }
            },
            isCancelledResult: (result) => (result as ChildAgentResult).status === 'cancelled',
            close: () => parent.dispose(),
          }
        },
      }),
    ).toEqual(['admission', 'catalog', 'cancel', 'unload'])
    expect(resources.size).toBe(0)
    await expect(
      context.childAgents.start(provider.id, 'after unload', {
        sessionKey: 'conformance-parent',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'E_PROVIDER_UNKNOWN' })
  } finally {
    await parent.dispose()
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('verifies sandbox cancellation and selected instance drain through a real Host service', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-sandbox-conformance-'))
  const { host, context } = await fixture(dataDir)
  let ready = deferred()
  const capabilities = {
    network: false,
    fsWrite: [],
    platform: [process.platform as 'darwin' | 'linux' | 'win32'],
    available: true,
  }
  let disposed = false
  let cleaned = false
  const provider: KindMap['sandbox'] = {
    id: 'conformance-box',
    version: '1.0.0',
    capabilities,
    create() {
      const lifetime = new AbortController()
      const pending = new Set<Promise<unknown>>()
      return {
        id: provider.id,
        capabilities,
        exec(request) {
          const signal = AbortSignal.any([request.signal ?? lifetime.signal, lifetime.signal])
          const result = aborted(signal).then(() => {
            throw signal.reason
          })
          pending.add(result)
          void result.finally(() => pending.delete(result)).catch(() => {})
          ready.resolve()
          return result
        },
        async dispose() {
          lifetime.abort()
          await Promise.allSettled([...pending])
          disposed = true
        },
      }
    },
    async cleanup() {
      expect(disposed).toBe(true)
      cleaned = true
    },
  }
  try {
    expect(
      await sandboxConformance({
        providers: context.providers,
        sourcePackage: '@agnes/code',
        provider,
        async open() {
          const instance = await context.sandboxProviders.select(provider.id, { workspaceRoot: dataDir })
          return {
            start(signal) {
              ready = deferred()
              return {
                ready: ready.promise,
                result: instance.exec({ argv: ['controlled'], cwd: dataDir, signal }),
              }
            },
            async close() {
              await instance.dispose()
            },
          }
        },
      }),
    ).toEqual(['admission', 'catalog', 'cancel', 'unload'])
    expect(cleaned).toBe(true)
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('verifies loop cancellation, unload drain and checkpoint cold resume through real Host sessions', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-loop-conformance-'))
  let ready = deferred()
  const codec = loopCheckpointCodec(1, (state) => {
    if (typeof state !== 'number') throw new Error('Invalid counter checkpoint')
    return state
  })
  const resources = new Set<LoopDriver>()
  function driver(ctx: LoopContext, initial: number): LoopDriver {
    let count = initial
    const instance: LoopDriver = {
      async step(signal) {
        if (!(await ctx.input.accept())) return { outcome: 'idle' }
        await ctx.events.emit('x/conformance/counter', { count })
        count++
        await ctx.checkpoints.write(codec.encode(count))
        ready.resolve()
        await aborted(signal)
        return ctx.turn.finishCancelled()
      },
      cancel() {},
      async dispose() {
        resources.delete(instance)
      },
      checkpoint: () => codec.encode(count),
    }
    resources.add(instance)
    return instance
  }
  const provider: LoopFactory = {
    id: 'conformance-loop',
    version: '1.0.0',
    capabilities: ['checkpoint'],
    codec,
    create: (ctx) => driver(ctx, 0),
    resume: (ctx, checkpoint) => driver(ctx, codec.decode(checkpoint) as number),
  }
  const { host, context } = await fixture(dataDir)
  let session = await host.createSession({ key: 'unused', cwd: dataDir })
  const enqueue = async () =>
    session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'advance counter' }],
      actor: session.d.actor,
    })
  try {
    expect(
      await loopConformance({
        providers: context.providers,
        sourcePackage: '@agnes/code',
        provider,
        async open() {
          session = await host.createSession({ key: 'counter', cwd: dataDir, loop: provider })
          return {
            start(signal) {
              ready = deferred()
              const result = enqueue().then(async () => {
                const cancel = () => {
                  void session.abort()
                }
                signal.addEventListener('abort', cancel, { once: true })
                try {
                  return await session.step()
                } finally {
                  signal.removeEventListener('abort', cancel)
                }
              })
              return { ready: ready.promise, result }
            },
            isCancelledResult: (result) => (result as { reason: string }).reason === 'aborted',
            async coldResume() {
              await session.close()
              const fresh = await fixture(dataDir, (ctx) => {
                ctx.providers.register('loop', '@agnes/code', provider)
              })
              try {
                const resumed = await fresh.host.createSession({ key: 'counter', cwd: dataDir })
                expect(resumed.loop).toEqual({ id: provider.id, version: provider.version })
                ready = deferred()
                await resumed.enqueue('next-turn', {
                  content: [{ type: 'text', text: 'resume counter' }],
                  actor: resumed.d.actor,
                })
                const cancel = new AbortController()
                const running = resumed.run({ until: 'turn-end', signal: cancel.signal })
                await ready.promise
                cancel.abort()
                expect(await running).toMatchObject({ reason: 'aborted' })
                expect(
                  (await resumed.scan({ type: 'x/conformance/counter', limit: 10 })).map(
                    (event) => event.data,
                  ),
                ).toEqual([{ count: 0 }, { count: 1 }])
              } finally {
                await fresh.host.close()
              }
              session = await host.createSession({ key: 'counter-unload', cwd: dataDir, loop: provider })
            },
            close: () => session.close(),
          }
        },
      }),
    ).toEqual(['admission', 'catalog', 'cancel', 'cold-resume', 'unload'])
    expect(resources.size).toBe(0)
    await expect(
      host.createSession({ key: 'after-unload', cwd: dataDir, loop: provider }),
    ).rejects.toMatchObject({ code: 'E_LOOP_MISSING' })
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('verifies persistence admission, non-cancellable read drain and cold resume through real Hosts', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-persistence-conformance-'))
  const { host, context } = await fixture(dataDir)
  const storageDir = join(dataDir, 'probe-store')
  const resumeDir = join(dataDir, 'resume-host')
  mkdirSync(storageDir)
  mkdirSync(resumeDir)
  let ready = deferred()
  const release = deferred()
  let storeClosed = false
  let readFinished = false
  const provider: KindMap['persistence'] = {
    ...sqlitePersistenceProvider,
    id: 'conformance-store',
    async open(options) {
      const store = await sqlitePersistenceProvider.open(options)
      if (options.dataDir !== storageDir) return store
      return {
        ...store,
        async scan(key, query) {
          ready.resolve()
          await release.promise
          const result = await store.scan(key, query)
          readFinished = true
          return result
        },
        async close() {
          expect(readFinished).toBe(true)
          await store.close()
          storeClosed = true
        },
      } as PersistenceSessionStore
    },
  }
  try {
    expect(
      await persistenceConformance({
        providers: context.providers,
        sourcePackage: '@agnes/code',
        provider,
        async open(selected) {
          const store = await selected.open({ dataDir: storageDir })
          await store.open('probe', { writerRunId: 'probe', ttlMs: 60_000 })
          return {
            cancellation: 'unsupported',
            start() {
              ready = deferred()
              return { ready: ready.promise, result: store.scan('probe', { limit: 1 }) }
            },
            async unloadStarted() {
              // A read without a signal must finish before the store can close.
              await Promise.resolve()
              expect(storeClosed).toBe(false)
              release.resolve()
            },
            async coldResume() {
              const boot = () =>
                createTestHost({
                  dataDir: resumeDir,
                  disableSessionTitle: true,
                  script: [
                    [
                      { type: 'text_delta', delta: 'durable reply' },
                      { type: 'done', reason: 'stop' },
                    ],
                  ],
                  profileInputs: { user: { name: 'local-dev', persistence: { provider: provider.id } } },
                  packages: { '@agnes/code': { persistenceProvider: selected } },
                })
              const first = await boot()
              try {
                const session = await first.host.createSession({ key: 'durable', cwd: resumeDir })
                await session.enqueue('next-turn', {
                  content: [{ type: 'text', text: 'durable input' }],
                  actor: session.d.actor,
                })
                expect(
                  await session.run({ until: 'turn-end', signal: new AbortController().signal }),
                ).toMatchObject({ reason: 'completed' })
              } finally {
                await first.host.close()
              }
              const second = await boot()
              try {
                const session = await second.host.createSession({ key: 'durable', cwd: resumeDir })
                expect((await session.scan({ type: 'assistant/message', limit: 1 }))[0]?.data).toMatchObject({
                  content: [{ type: 'text', text: 'durable reply' }],
                })
                expect(second.host.providers.catalog()).toContainEqual(
                  expect.objectContaining({ kind: 'persistence', id: provider.id, active: true }),
                )
              } finally {
                await second.host.close()
              }
            },
            close: () => store.close(),
          }
        },
      }),
    ).toEqual(['admission', 'catalog', 'cancel-unsupported', 'cold-resume', 'unload'])
    expect(readFinished).toBe(true)
    expect(storeClosed).toBe(true)
  } finally {
    release.resolve()
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
