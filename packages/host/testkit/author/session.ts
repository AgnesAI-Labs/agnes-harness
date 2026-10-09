import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { Plugin } from '@agnes/cordis'
import { type Event, type Provider, scanAll } from '@agnes/core'
import type { LoopPluginContext } from '@agnes/extension-api'
import {
  type LoopContext,
  type LoopFactory,
  type LoopStepOutcome,
  loopCheckpointCodec,
  loopShouldStop,
  registerLoopPlugin,
  type ToolResult,
} from '@agnes/extension-api'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import { developmentPluginRows, hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { defineLoop } from '@agnes/plugin-runtime'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import type { RouteDecl, UiActionParams, UiActionReceipt, UiReadParams, UiReadResult } from '@agnes/protocol'
import type { Host, HostSession } from '../../src/runtime/lifecycle/host.js'
import { createTestHost, type TestHostOptions } from '../index.js'

export interface AuthorPluginVersion {
  plugin: Plugin
  version: string
  config?: unknown
}
export interface AuthorTestOptions extends AuthorPluginVersion {
  packageId?: string
  loop?: { id: string; version: string }
  provider?: Provider
  replies?: TestHostOptions['script']
  /** Defaults to deny. This callback is the real Host approval seam. */
  approval?: TestHostOptions['approval']
  /** Explicit test seam overrides; no credentials or user home are loaded. */
  seams?: TestHostOptions['seams']
  /** Explicit source directories for installed official plugin manifests in isolated fixtures. */
  packageDirs?: TestHostOptions['packageDirs']
  presets?: TestHostOptions['presets']
  preset?: string
}
export interface AuthorSession {
  readonly key: string
  readonly generation: string | undefined
  readonly loop: HostSession['loop']
  enqueue(text: string): Promise<void>
  /** Advance at most N public Loop edges; stop at idle, parked or turn-end. */
  drive(steps: number, signal?: AbortSignal): Promise<LoopStepOutcome[]>
  /** Uses a Core-controlled tool Loop, with policy, approval and durable effects. */
  invoke(name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult>
  uiAction(input: Omit<UiActionParams, 'sessionId'>): Promise<UiActionReceipt>
  uiRead(input?: Omit<UiReadParams, 'sessionId'>): Promise<UiReadResult>
  facts(): Promise<Event[]>
  effects(): Promise<Event[]>
  assertApproval(verdict: string): Promise<void>
  assertRefused(name: string, code?: string): Promise<void>
  assertPinned(generation: string): void
  close(): Promise<void>
}
export interface AuthorTestkit {
  openSession(options?: { key?: string; loop?: AuthorTestOptions['loop'] }): Promise<AuthorSession>
  /** Returns the pin for the kit's default preset/Loop, using a transient session without driving it. */
  reload(next: AuthorPluginVersion): Promise<string>
  dispose(): Promise<void>
}
const invocationLoop = { id: 'author.invoke', version: '1.0.0' }
const codec = loopCheckpointCodec(1, (state) => state)

/** Isolated actual Host assembly: synthetic snapshot files, author module imports, production pins. */
export async function createAuthorTestkit(options: AuthorTestOptions): Promise<AuthorTestkit> {
  const directory = await mkdtemp(join(tmpdir(), 'agh-author-'))
  const id = options.packageId ?? '@author/plugin'
  const sources: RuntimePluginSnapshot[] = []
  const modules = new Map<string, { main: Plugin }>()
  const results = new Map<string, ToolResult>()
  let host: Host | undefined
  let disposed = false
  let disposal: Promise<void> | undefined
  let sessionNumber = 0
  let mutation = false
  const check = () => {
    if (disposed) throw new Error('Author testkit disposed')
  }
  async function snapshot(next: AuthorPluginVersion): Promise<RuntimePluginSnapshot> {
    if (!next.version || sources.some((source) => source.snapshot.version === next.version))
      throw new Error('Each author snapshot needs a new, nonempty version')
    const entry = normalizePluginExport(next.plugin)
    const folder = join(directory, 'snapshots', String(sources.length + 1))
    await mkdir(folder, { recursive: true })
    const moduleText = `// Imported author module supplied by the test.\nexport const version = ${JSON.stringify(next.version)}\n`
    await writeFile(join(folder, 'index.mjs'), moduleText)
    await writeFile(
      join(folder, 'package.json'),
      JSON.stringify({
        name: id,
        version: next.version,
        type: 'module',
        exports: './index.mjs',
        agnes: {
          plugins: [
            {
              export: 'main',
              id: `ext:${id}/main`,
              apiRange: '^1.4.0',
              default: true,
              inject: Object.keys(entry.inject),
              provide: entry.provides,
              runtime: 'in-process',
              ...(next.config === undefined ? {} : { config: next.config }),
            },
          ],
        },
      }),
    )
    const integrity = hashDirectory(folder, { exclude: [] })
    const source: RuntimePluginSnapshot = {
      snapshot: {
        packageId: id,
        profile: 'local-dev',
        version: next.version,
        directory: folder,
        snapshotId: integrity,
        integrity,
        treeIntegrity: integrity,
        capabilityHash: createHash('sha256').update(id).digest('hex'),
        contributions: [],
      },
      generation: sources.length + 1,
      trusted: true,
    }
    modules.set(moduleText, { main: next.plugin })
    sources.push(source)
    return source
  }
  const toolLoop: LoopFactory = defineLoop({
    ...invocationLoop,
    codec,
    capabilities: ['tools'],
    create(ctx: LoopContext) {
      return {
        async step(signal) {
          const input = await ctx.input.accept()
          if (!input) return { outcome: 'idle' as const, phase: 'idle' }
          const text = input.content.find((block) => block.type === 'text')
          if (!text || text.type !== 'text') throw new Error('Author invoke needs a tool call')
          const call = JSON.parse(text.text)
          const result = await ctx.tools.execute({ ...call, invocationId: `author:${input.id}` }, signal)
          results.set(ctx.sessionKey, result)
          await ctx.checkpoints.write(codec.encode(null))
          await ctx.events.finish('completed')
          return { outcome: 'turn-ended' as const, phase: 'done', reason: 'completed' as const }
        },
        checkpoint: () => codec.encode(null),
        cancel() {},
        dispose() {},
      }
    },
    resume(ctx: LoopContext) {
      return toolLoop.create(ctx, new AbortController().signal)
    },
  })
  try {
    const first = await snapshot(options)
    const models = options.provider?.models()
    const primary = models?.[0]
    if (models && !primary) throw new Error('Author model provider needs a nonempty catalogue')
    const routes = new Map<string, RouteDecl>()
    for (const model of models ?? []) {
      const route = routes.get(model.route) ?? {
        route: model.route,
        api: model.api,
        baseUrl: model.baseUrl,
        models: [],
      }
      route.models!.push(model)
      routes.set(model.route, route)
    }
    host = (
      await createTestHost({
        ...(options.presets
          ? { presets: options.presets, allowed: ['standard', ...Object.keys(options.presets)] }
          : {}),
        dataDir: directory,
        disableSessionTitle: true,
        env: {},
        provider:
          options.provider ??
          ((profile) =>
            new ScriptedProvider({
              models: profile.provider.routes?.flatMap((route) => route.models ?? []) ?? [],
              scripts: options.replies ?? [],
              onExhausted: 'error',
            })),
        ...(options.seams ? { seams: options.seams } : {}),
        approval: async (request) => {
          const answer = await (options.approval?.(request) ?? Promise.resolve('rejected' as const))
          return answer
        },
        profileInputs: {
          user: {
            name: 'local-dev',
            composition: {},
            packages: [{ id, source: 'author-fixture' }],
            ...(primary
              ? { provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [...routes.values()] } }
              : {}),
          },
        },
        ...(primary
          ? {
              presets: {
                ...options.presets,
                standard: {
                  name: 'standard',
                  extends: 'base',
                  model: { route: { primary: primary.route }, id: { primary: primary.id } },
                },
              },
            }
          : {}),
        lock: {
          packages: Object.fromEntries([
            ...['@agnes/ai', '@agnes/base', '@agnes/code'].map((name) => [
              name,
              { version: '0.1.0', integrity: 'sha512-fixture', trust: 'builtin', enabled: true },
            ]),
            [
              id,
              {
                version: first.snapshot.version,
                integrity: first.snapshot.integrity,
                trust: 'trusted',
                enabled: true,
              },
            ],
          ]),
        },
        packageDirs: { ...options.packageDirs, [id]: first.snapshot.directory },
        runtimePluginSnapshots: [first],
        runtimePluginCatalogue: [first],
        runtimePluginSources: async () => sources,
        extensionLoader: {
          async import(file) {
            const module = modules.get(await readFile(file, 'utf8'))
            if (!module) throw new Error('Unknown author module')
            return module
          },
        },
        packages: {
          '@agnes/code': {
            plugins: [
              {
                declaration: {
                  export: 'authorLoop',
                  id: 'loop:author.invoke',
                  apiRange: '^1.4.0',
                  default: true,
                  inject: ['loops'],
                  provide: [],
                  runtime: 'in-process',
                },
                entry: normalizePluginExport({
                  inject: ['loops'],
                  apply(ctx: LoopPluginContext) {
                    registerLoopPlugin(ctx, '@agnes/code', toolLoop)
                  },
                }),
              },
            ],
          },
        },
      })
    ).host
    const owner = host
    const createSession = (key: string, loop = options.loop ?? invocationLoop) =>
      owner.createSession({
        key,
        cwd: directory,
        ...(options.preset ? { preset: options.preset } : {}),
        loop,
      })
    const failed = owner.extensions().find((entry) => entry.package === id && (!entry.loaded || entry.error))
    if (failed) throw new Error(failed.error?.message ?? 'Author plugin failed to load')
    return {
      async openSession(input = {}) {
        check()
        if (mutation) throw new Error('Author reload in progress')
        const session = await createSession(input.key ?? `author-${++sessionNumber}`, input.loop)
        let active = false
        let closed = false
        const ready = () => {
          check()
          if (closed) throw new Error('Author session closed')
          if (active) throw new Error('Author session busy')
        }
        const facts = () => scanAll((query) => session.scan(query), { fromSeq: 1, toSeq: session.lastSeq })
        async function drive(steps: number, signal = new AbortController().signal, owned = false) {
          if (!owned) ready()
          if (!Number.isSafeInteger(steps) || steps < 1) throw new RangeError('steps must be positive')
          signal.throwIfAborted()
          active = true
          let cancellation: Promise<unknown> | undefined
          const abort = () => {
            cancellation = session.abort()
            // Attach a handler immediately; cleanup below still propagates the error.
            void cancellation.catch(() => undefined)
          }
          signal.addEventListener('abort', abort, { once: true })
          try {
            const outcomes: LoopStepOutcome[] = []
            for (let i = 0; i < steps; i++) {
              signal.throwIfAborted()
              const outcome = await session.step()
              signal.throwIfAborted()
              outcomes.push(outcome)
              if (loopShouldStop(outcome, 'turn-end')) break
            }
            return outcomes
          } finally {
            signal.removeEventListener('abort', abort)
            try {
              if (cancellation) {
                await cancellation
                await session.drainCancelledTurn()
                await session.restartLoopDriver()
              }
            } finally {
              active = false
            }
          }
        }
        return {
          key: session.key,
          generation: session.pluginGenerationId,
          loop: session.loop,
          async enqueue(text) {
            ready()
            active = true
            try {
              await session.enqueue('next-turn', {
                content: [{ type: 'text', text }],
                actor: session.d.actor,
              })
            } finally {
              active = false
            }
          },
          drive,
          async invoke(name, args, signal) {
            ready()
            if (session.loop.id !== invocationLoop.id)
              throw new Error(
                'invoke requires an author.invoke session; open a separate session for your Loop',
              )
            signal?.throwIfAborted()
            const data = JSON.stringify({ name, args })
            active = true
            try {
              await session.enqueue('next-turn', {
                content: [{ type: 'text', text: data }],
                actor: session.d.actor,
              })
              results.delete(session.key)
              await drive(1, signal, true)
              const result = results.get(session.key)
              if (!result) throw new Error('Tool did not complete; inspect the parked ledger facts')
              return structuredClone(result)
            } finally {
              active = false
            }
          },
          async uiAction(input) {
            ready()
            if (!session.intelligentUi) throw new Error('Intelligent UI plugin unavailable')
            active = true
            try {
              return await session.intelligentUi.action(
                { ...input, sessionId: session.key },
                session.d.actor,
                new AbortController().signal,
              )
            } finally {
              active = false
            }
          },
          async uiRead(input = {}) {
            ready()
            if (!session.intelligentUi) throw new Error('Intelligent UI plugin unavailable')
            active = true
            try {
              return await session.intelligentUi.read(
                { ...input, sessionId: session.key },
                new AbortController().signal,
              )
            } finally {
              active = false
            }
          },
          facts,
          effects: async () => (await facts()).filter((event) => event.type.startsWith('effect/')),
          async assertApproval(verdict) {
            const events = await facts()
            assert.ok(
              events.some((event) => event.type === 'approval/asked'),
              'No durable approval request',
            )
            assert.ok(
              events.some(
                (event) =>
                  event.type === 'approval/decided' &&
                  (event.data as { verdict: string }).verdict === verdict,
              ),
              `No ${verdict} approval`,
            )
          },
          async assertRefused(name, code) {
            const events = await facts()
            const call = events.findLast(
              (event) => event.type === 'tool/call' && (event.data as { name: string }).name === name,
            )
            assert.ok(call, `No tool call: ${name}`)
            const toolUseId = (call.data as { toolUseId: string }).toolUseId
            assert.ok(
              events.some(
                (event) =>
                  event.type === 'tool/result' &&
                  (event.data as { toolUseId: string; isError?: boolean; code?: string }).toolUseId ===
                    toolUseId &&
                  (event.data as { isError?: boolean }).isError &&
                  (!code || (event.data as { code?: string }).code === code),
              ),
              'No refusal result',
            )
            assert.ok(
              !events.some(
                (event) =>
                  event.type === 'effect/intent' &&
                  (event.data as { tool?: { toolUseId?: string } }).tool?.toolUseId === toolUseId,
              ),
              'Refused tool dispatched an effect',
            )
          },
          assertPinned(generation) {
            assert.equal(session.pluginGenerationId, generation)
          },
          async close() {
            if (closed) return
            closed = true
            await session.close()
            results.delete(session.key)
          },
        }
      },
      async reload(next) {
        check()
        if (mutation) throw new Error('Author reload in progress')
        mutation = true
        try {
          const source = await snapshot(next)
          const current = owner.runtimeTargetSnapshot?.()
          if (!current) throw new Error('Host runtime target unavailable')
          try {
            const report = await owner.applyRuntimeTarget(
              buildCompleteRuntimeTarget({
                rows: [
                  ...current.tree.rows.filter((row) => !row.plugin.startsWith(`${id}@`)),
                  ...developmentPluginRows(source, []),
                ],
                resources: current.resource.resources,
              }).target,
            )
            if (!report.ok) throw new Error('Author plugin publication failed')
            // Catalog changes can select a different composition from the initial Host.
            // Admit with the same defaults as openSession and read its actual code pin.
            const key = `author-reload-${randomUUID()}`
            let probe: HostSession | undefined
            try {
              probe = await createSession(key)
              const generation = probe.pluginGenerationId
              if (!generation) throw new Error('Host generation unavailable')
              return generation
            } finally {
              try {
                await probe?.close()
              } finally {
                await owner.releaseSessionGeneration?.(key)
              }
            }
          } catch (error) {
            // A rejected candidate must not remain the catalog for future admissions.
            const restored = await owner.applyRuntimeTarget(current)
            if (!restored.ok) throw new AggregateError([error], 'Author plugin publication recovery failed')
            throw error
          }
        } finally {
          mutation = false
        }
      },
      dispose() {
        if (disposal) return disposal
        disposed = true
        disposal = (async () => {
          try {
            await owner.close()
          } finally {
            await rm(directory, { recursive: true, force: true })
          }
        })()
        return disposal
      },
    }
  } catch (error) {
    try {
      await host?.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    throw error
  }
}
