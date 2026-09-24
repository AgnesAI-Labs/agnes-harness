import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HookEngine, HookRegistry, SessionHookPort } from '@agnes/core'
import type {
  ExtensionManifest,
  ProjectionDef,
  ProjectionReader,
  ProjectionReadResult,
} from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindExtensionInvocations } from '../../src/assemble/extension-ports.js'
import { buildExtensionAPI } from '../../src/ext-host/api-proxy.js'
import { DisposerBag } from '../../src/ext-host/disposers.js'
import { leaseFor } from '../../src/ext-host/lease.js'
import { createTestHost } from '../../testkit/index.js'
import { fixtureTool } from '../fixtures/tool.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release()
})
const log = { debug() {}, info() {}, warn() {}, error() {} }
const platform = Object.freeze({
  shell: 'posix',
  fs: Object.freeze({ caseSensitive: true, pathSep: '/' }),
  terminal: Object.freeze({ color: false }),
} as const)
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-projection-'))
  const { host } = await createTestHost({
    dataDir: dir,
    currentRuntime: { current: () => undefined },
    script: [
      [
        {
          type: 'toolcall_end',
          call: { toolUseId: '', name: 'fx_read', args: {}, ordinal: 0 },
          via: 'native',
        },
        { type: 'done', reason: 'toolUse' },
      ],
      [{ type: 'done', reason: 'stop' }],
    ],
  })
  const session = await host.createSession({ key: 'projection', cwd: dir })
  const hooks = new HookRegistry(),
    registry = host.kernel.projections
  const ports = bindExtensionInvocations(
    {
      tools: host.kernel.tools,
      hooks,
      slots: host.kernel.slots,
      resources: host.kernel.resources,
      projections: registry,
      registrations: (id) => host.kernel.registrations(id),
    },
    (ref) => host.kernel.get(ref.key),
  )
  cleanup.push(async () => {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const author = (id = 'fixture/projection') => {
    const manifest: ExtensionManifest = {
      id,
      version: '1.0.0',
      apiRange: '^1.0',
      entry: './index.ts',
      capabilities: {
        projections: ['count', 'other'].map((name) => ({
          name,
          inputEventTypes: [`x/${id}/count`],
          maxStateBytes: 1024,
        })),
        slots: ['status.line'],
        hooks: ['before_step'],
        events: true,
        tools: { prefix: 'fx_', names: ['fx_read'] },
      },
    }
    const bag = new DisposerBag(),
      lease = leaseFor(manifest, { now: Date.now(), ttlMs: 60000 })
    cleanup.push(async () => {
      lease.revoke('test')
      await bag.disposeAllAsync()
    })
    const api = buildExtensionAPI({
      manifest,
      packageIdentity: '@fixture/package',
      packageVersion: manifest.version,
      lease,
      bag,
      ports,
      trust: 'trusted',
      signal: new AbortController().signal,
      isRegistering: () => true,
      info: { agnesVersion: '0.0.0', apiVersion: '1.0.0', profileName: 'test' },
      platform,
      log,
    })
    return { api, bag, lease }
  }
  const runSlot = (signal?: AbortSignal) =>
    host.kernel.slots.snapshot(
      { key: session.key, lane: session.lane, workspaceRoot: session.d.cwd },
      { remainingMs: () => 1000, ...(signal ? { signal } : {}) },
    )('tui', { kind: 'tick' })
  return { host, session, registry, hooks, author, runSlot }
}
const counter = (): ProjectionDef<number> => ({
  name: 'count',
  stateVersion: 1,
  stateSchema: { type: 'integer' },
  init: () => 0,
  apply: (state) => state + 1,
})

describe('P4/P5 production Projection ports', () => {
  it('filters exact events, reads only one key and never exposes cached state', async () => {
    const h = await setup(),
      { api } = h.author()
    const apply = vi.fn((state: number) => state + 1),
      other = vi.fn(() => 0)
    api.registerProjection({ ...counter(), apply, view: (n) => ({ count: n }) })
    api.registerProjection({ ...counter(), name: 'other', init: other })
    let saved!: ProjectionReader
    api.registerSlot('status.line', async (ctx) => {
      saved = ctx.projections
      await api.events.append('unrelated', {})
      await api.events.append('count', {})
      const first = await ctx.projections.readOwn<{ count: number }>('count')
      expect(first.status).toBe('available')
      if (first.status === 'available') first.value.count = 999
      const next = await ctx.projections.readOwn('count')
      expect(next).toMatchObject({ status: 'available', value: { count: 1 }, stateVersion: 1 })
      return { text: 'read', level: 'info' }
    })
    await h.runSlot()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    expect(await saved.readOwn('count')).toMatchObject({ status: 'unavailable' })
    await expect(saved.readOwn('../other')).rejects.toThrow('E_CAPABILITY_UNDECLARED')
  })
  it('binds reads to the current extension owner and rejects a borrowed reader', async () => {
    const h = await setup(),
      a = h.author(),
      b = h.author('fixture/other')
    a.api.registerProjection(counter())
    let saved!: ProjectionReader
    const release = a.api.registerSlot('status.line', (ctx) => {
      saved = ctx.projections
      return null
    })
    await h.runSlot()
    release()
    let result: ProjectionReadResult | undefined
    b.api.registerSlot('status.line', async () => {
      result = await saved.readOwn('count')
      return null
    })
    await h.runSlot()
    expect(result).toMatchObject({ status: 'unavailable' })
    expect(h.registry.cacheLine(h.session.key, 'fixture/projection/count')).toBeUndefined()
  })
  it.each(['undefined', 'function', 'cycle', 'schema', 'size', 'promise', 'throw'])(
    'quarantines only the bad key: %s',
    async (kind) => {
      const h = await setup(),
        { api, bag } = h.author()
      const cycle: Record<string, unknown> = {}
      cycle.self = cycle
      const badInit = () =>
        kind === 'promise'
          ? Promise.reject(new Error('hidden'))
          : kind === 'throw'
            ? (() => {
                throw new Error('SECRET')
              })()
            : kind === 'undefined'
              ? undefined
              : kind === 'function'
                ? () => 1
                : kind === 'cycle'
                  ? cycle
                  : kind === 'schema'
                    ? {}
                    : 'x'.repeat(2000)
      api.registerProjection({
        ...counter(),
        stateSchema: { type: kind === 'size' ? 'string' : 'integer' },
        init: badInit as never,
      })
      api.registerProjection({ ...counter(), name: 'other' })
      let result: unknown, good: unknown
      api.registerSlot('status.line', async (ctx) => {
        result = await ctx.projections.readOwn('count')
        good = await ctx.projections.readOwn('other')
        return null
      })
      await h.runSlot()
      expect(result).toEqual({
        name: 'count',
        status: 'unavailable',
        error: { code: 'E_PROJECTION_STATE', safeMessage: 'projection unavailable' },
      })
      expect(good).toMatchObject({ status: 'available', value: 0 })
      expect(h.registry.failures()).toHaveLength(1)
      expect(
        await h.session.scan({ type: 'x/core/projection-failed', toSeq: h.session.lastSeq }),
      ).toHaveLength(1)
      await h.runSlot()
      expect(
        await h.session.scan({ type: 'x/core/projection-failed', toSeq: h.session.lastSeq }),
      ).toHaveLength(1)
      await bag.disposeAllAsync()
      expect(h.registry.failures()).toEqual([])
      expect(h.registry.cacheLine(h.session.key, 'fixture/projection/other')).toBeUndefined()
      expect(h.registry.registrations('fixture/projection')).toEqual([])
    },
  )
  it('rejects undeclared keys, invalid schemas, async schemas and invalid versions before registration', async () => {
    const h = await setup(),
      { api } = h.author()
    expect(() => api.registerProjection({ ...counter(), name: '../surface' })).toThrow(
      'E_CAPABILITY_UNDECLARED',
    )
    for (const def of [
      { ...counter(), stateVersion: 0 },
      { ...counter(), stateSchema: { $ref: 'https://invalid.example/schema' } },
      { ...counter(), stateSchema: { $async: true, type: 'integer' } },
      { ...counter(), stateSchema: { type: 'invented' } },
    ])
      expect(() => api.registerProjection(def)).toThrow('E_PROJECTION_DEF')
    expect(h.registry.registrations('fixture/projection')).toEqual([])
  })
  it('validates views and preserves immutable input state', async () => {
    const h = await setup(),
      { api } = h.author()
    api.registerProjection({ ...counter(), view: () => 'x'.repeat(1025) })
    api.registerProjection({
      name: 'other',
      stateVersion: 1,
      stateSchema: {
        type: 'object',
        properties: { n: { type: 'integer' } },
        required: ['n'],
        additionalProperties: false,
      },
      init: () => ({ n: 0 }),
      apply: (state) => {
        ;(state as { n: number }).n++
        return state
      },
    })
    const results: unknown[] = []
    api.registerSlot('status.line', async (ctx) => {
      await api.events.append('count', {})
      results.push(await ctx.projections.readOwn('count'), await ctx.projections.readOwn('other'))
      return null
    })
    await h.runSlot()
    expect(results).toEqual([
      expect.objectContaining({ status: 'unavailable' }),
      expect.objectContaining({ status: 'unavailable' }),
    ])
    expect(h.registry.failures()).toHaveLength(2)
  })
  it('replays after owner disposal and a stateVersion change without reusing old cache', async () => {
    const h = await setup(),
      { api } = h.author()
    const old = api.registerProjection(counter())
    let append = true,
      result: unknown
    api.registerSlot('status.line', async (ctx) => {
      if (append) {
        await api.events.append('count', {})
        append = false
      }
      result = await ctx.projections.readOwn('count')
      return null
    })
    await h.runSlot()
    expect(result).toMatchObject({ status: 'available', value: 1, stateVersion: 1 })
    old()
    expect(h.registry.cacheLine(h.session.key, 'fixture/projection/count')).toBeUndefined()
    api.registerProjection({ ...counter(), stateVersion: 2, init: () => 10 })
    old()
    await h.runSlot()
    expect(result).toMatchObject({ status: 'available', value: 11, stateVersion: 2 })
  })
  it.each(['cancel', 'revoke', 'expire'])(
    'does not fold after a pending read loses authorization: %s',
    async (kind) => {
      const h = await setup(),
        { api, lease } = h.author(),
        init = vi.fn(() => 0)
      api.registerProjection({ ...counter(), init })
      let enter!: () => void, resume!: () => void
      const entered = new Promise<void>((r) => {
          enter = r
        }),
        waiting = new Promise<void>((r) => {
          resume = r
        })
      const scan = h.session.scan.bind(h.session)
      vi.spyOn(h.session, 'scan').mockImplementationOnce(async (query) => {
        enter()
        await waiting
        return scan(query)
      })
      let finished!: () => void
      const done = new Promise<void>((r) => {
        finished = r
      })
      api.registerSlot('status.line', async (ctx) => {
        await ctx.projections.readOwn('count')
        finished()
        return null
      })
      const ac = new AbortController(),
        pending = h.runSlot(ac.signal)
      await entered
      if (kind === 'cancel') ac.abort()
      else if (kind === 'revoke') lease.revoke('test')
      else vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60001)
      resume()
      await done
      await pending
      vi.restoreAllMocks()
      expect(init).not.toHaveBeenCalled()
    },
  )
  it('uses the same reader for actual Hook and Tool callbacks on the real session', async () => {
    const h = await setup(),
      { api, lease } = h.author(),
      seen: JsonValue[] = []
    api.registerProjection(counter())
    api.registerHook('before_step', async (_p, ctx) => {
      await api.events.append('count', {})
      const r = await ctx.projections.readOwn('count')
      if (r.status === 'available') seen.push(r.value)
      return {}
    })
    const tool = fixtureTool('fx_read')
    tool.execute = async (_args, ctx) => {
      const r = await ctx.projections.readOwn('count')
      if (r.status === 'available') seen.push(r.value)
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    api.registerTool(tool)
    h.session.hooks = new SessionHookPort(new HookEngine({ diag() {}, onFailure() {}, platform }, h.hooks), {
      context: () => ({
        session: { key: h.session.key, lane: h.session.lane, workspaceRoot: h.session.d.cwd },
        signal: h.session.ac.signal,
        replayed: false,
        lease: lease.view(),
        log,
      }),
      budget: () => ({ remaining: 10, cap: null }),
      surface: () => [],
      surfaceDigest: () => ({ nodes: 0, tokensEstimate: 0 }),
      verifierTier: () => 0,
      contextOverflow() {},
      compactPlanIgnored() {},
    })
    await h.session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'run' }],
      actor: h.session.d.actor,
    })
    expect((await h.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(seen.slice(0, 2)).toEqual([1, 1])
  })
})
