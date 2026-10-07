import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@agnes/cordis'
import type { KindMap, ProviderRegistrationPort } from '@agnes/extension-api'
import { runProviderConformance } from '@agnes/extension-api/testkit'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

it('runs the public provider suites through an assembled Host and its ordinary plugin owner', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-provider-conformance-'))
  let providers!: ProviderRegistrationPort
  const { host } = await createTestHost({
    dataDir,
    script: [],
    disableSessionTitle: true,
    packages: {
      '@agnes/code': {
        plugins: [
          {
            declaration: {
              id: 'providers:conformance',
              export: 'main',
              apiRange: '^1.4.0',
              runtime: 'in-process',
              default: true,
              inject: ['providers'],
            },
            entry: normalizePluginExport({
              inject: ['providers'],
              apply(ctx: Context) {
                providers = ctx.providers
              },
            }),
          },
        ],
      },
    },
  })
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    return { resolve, promise }
  }
  let ready = deferred()
  const wait = async (signal: AbortSignal) => {
    signal.throwIfAborted()
    ready.resolve()
    await new Promise<never>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    )
  }
  const call = { id: 'test', name: 'test', args: {}, concurrencySafe: false }
  const disposal: string[] = []
  const instanceDisposed = () => {
    disposal.push('instance')
  }
  const cleanup = () => {
    disposal.push('registration')
  }
  const definitions: Pick<KindMap, 'tool-policy' | 'tool-runtime' | 'compaction' | 'model-adapter'> = {
    'tool-policy': {
      id: 'conformance-policy',
      version: '1.0.0',
      decide: async (_input, signal) => {
        await wait(signal)
        return { effect: 'deny', reason: 'test' }
      },
      dispose: instanceDisposed,
      cleanup,
    },
    'tool-runtime': {
      id: 'conformance-runtime',
      version: '1.0.0',
      create: async () => ({
        execute: async (_call, _execution, signal) => {
          await wait(signal)
          return { content: [] }
        },
        batch: async (_calls, _execution, signal) => {
          await wait(signal)
          return []
        },
        cancel: async () => {},
        dispose: instanceDisposed,
      }),
      cleanup,
    },
    compaction: {
      id: 'conformance-compaction',
      version: '1.0.0',
      create: async () => ({
        shouldCompact: () => true,
        compact: async (_input, ports) => {
          await wait(ports.signal)
          return null
        },
        dispose: instanceDisposed,
      }),
      cleanup,
    },
    'model-adapter': {
      id: 'conformance-model',
      wireApi: 'test-wire',
      version: '1.0.0',
      capabilities: { tools: false, imageInput: false, streaming: true },
      create: async () => ({
        id: 'test-wire',
        routes: () => [],
        models: () => [],
        async *stream(_route, _request, options) {
          await wait(options.signal)
          yield { type: 'done', reason: 'stop' }
        },
        dispose: instanceDisposed,
      }),
      cleanup,
    },
  }
  try {
    const exercise = async <K extends keyof typeof definitions>(kind: K) => {
      const cases = await runProviderConformance(kind, {
        providers,
        sourcePackage: '@agnes/code',
        provider: definitions[kind] as KindMap[K],
        async open(provider) {
          let invoke: (signal: AbortSignal) => Promise<unknown>
          let close = async () => {}
          if (kind === 'tool-policy') {
            const policy = provider as KindMap['tool-policy']
            invoke = async (signal) => policy.decide({} as never, signal)
          } else if (kind === 'tool-runtime') {
            const runtime = await (provider as KindMap['tool-runtime']).create({ maxParallel: 1 })
            invoke = (signal) => runtime.execute(call, { dispatch: async () => ({ content: [] }) }, signal)
            close = async () => {
              await runtime.dispose()
            }
          } else if (kind === 'compaction') {
            const engine = await (provider as KindMap['compaction']).create()
            invoke = (signal) => engine.compact({} as never, { signal, model: { summarize: async () => '' } })
            close = async () => {
              await engine.dispose?.()
            }
          } else {
            const adapter = await (provider as KindMap['model-adapter']).create({ routes: [] })
            invoke = async (signal) => {
              for await (const _event of adapter.stream('test', {} as never, {
                signal,
                toolNames: [],
                sessionKey: 'test',
                timeoutMs: { firstToken: 1000, total: 1000 },
              })) {
              }
            }
            close = async () => {
              await adapter.dispose?.()
            }
          }
          return {
            start(signal) {
              ready = deferred()
              return { ready: ready.promise, result: invoke(signal) }
            },
            close,
          }
        },
      })
      expect(cases).toEqual(['admission', 'catalog', 'cancel', 'unload'])
      expect(disposal.splice(0)).toEqual(['instance', 'registration'])
      expect(host.providers.catalog().some((entry) => entry.id === definitions[kind].id)).toBe(false)
    }
    await exercise('tool-policy')
    await exercise('tool-runtime')
    await exercise('compaction')
    await exercise('model-adapter')
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
