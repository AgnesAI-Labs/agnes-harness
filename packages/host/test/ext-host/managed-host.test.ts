import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HookEngine, HookRegistry, ResourceRegistry, SlotRegistry } from '@agnes/core'
import { API_VERSION, type ExtensionAPI, type ExtensionManifest } from '@agnes/extension-api'
import { afterEach, expect, it, vi } from 'vitest'
import { bindExtensionInvocations } from '../../src/assemble/extension-ports.js'
import { createLoader } from '../../src/ext-host/loader.js'
import { createManagedExtHost, type ExtensionSpec } from '../../src/ext-host/managed-host.js'
import { ServiceRegistry } from '../../src/ext-host/services.js'
import { createTestHost, type TestHost } from '../../testkit/index.js'
import { fixtureTool } from '../fixtures/tool.js'

const held: Array<{
  root: string
  host: TestHost['host']
  managed: ReturnType<typeof createManagedExtHost>
}> = []
afterEach(async () => {
  for (const h of held.splice(0)) {
    await h.managed.disposeAll()
    await h.host.close()
    rmSync(h.root, { recursive: true, force: true })
  }
})
const ceiling = ['tools', 'hooks', 'slots', 'resources', 'events']
const platform = Object.freeze({
  shell: 'posix',
  fs: Object.freeze({ caseSensitive: true, pathSep: '/' }),
  terminal: Object.freeze({ color: false }),
} as const)
const caps: ExtensionManifest['capabilities'] = {
  tools: { prefix: 'fx_', names: ['fx_tool'] },
  hooks: ['before_step'],
  slots: ['status.line'],
  resources: ['skill'],
  events: true,
}
const body = `const tool = ${JSON.stringify(fixtureTool('fx_tool'))}; tool.meta.costHint = undefined; tool.parameters = Type.Object({}, { additionalProperties: false });
tool.execute = async () => { await api.events.append('note', { kind: 'tool' }); return { content: [{ type: 'text', text: 'ok' }] } };
api.registerTool(tool); api.registerHook('before_step', () => ({}));
api.registerSlot('status.line', () => ({ text: 'loaded', level: 'info' }));
api.registerResource({ id: 's', kind: 'skill', name: 's', description: 'loaded' });`
function extension(root: string, name: string, source: string, capabilities = caps): ExtensionSpec {
  const dir = join(root, name)
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'agnes.extension.json'),
    JSON.stringify({
      id: `fixture/${name}`,
      version: '1.0.0',
      apiRange: `^${API_VERSION}`,
      entry: './index.ts',
      capabilities,
    }),
  )
  writeFileSync(join(dir, 'index.ts'), `import { Type } from '@sinclair/typebox';\n${source}`)
  return {
    id: `fixture/${name}`,
    package: '@fixture/package',
    packageVersion: '1.0.0',
    dir,
    trust: 'builtin',
    enabled: true,
  }
}
async function setup(
  options: {
    ceiling?: string[]
    failSinks?: boolean
    seamPackages?: Set<string>
    reloadableExtensions?: Set<string>
    clock?: () => number
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'agnes-managed-'))
  const { host } = await createTestHost({
    dataDir: root,
    currentRuntime: { current: () => undefined },
    script: [
      [
        {
          type: 'toolcall_end',
          call: { toolUseId: '', name: 'fx_tool', args: {}, ordinal: 0 },
          via: 'native',
        },
        { type: 'done', reason: 'toolUse' },
      ],
      [{ type: 'done', reason: 'stop' }],
    ],
  })
  const session = await host.createSession({ key: 'managed', cwd: root })
  const hooks = new HookRegistry(),
    slots = new SlotRegistry(),
    resources = new ResourceRegistry(),
    services = new ServiceRegistry()
  const registrations = (id: string) => [
    ...[...host.kernel.tools.snapshot(0).byName.values()]
      .filter((t) => t.source.source === id)
      .map((t) => `tool:${t.name}`),
    ...hooks.registrations(id),
    ...slots.registrations(id),
    ...resources.registrations(id),
    ...host.kernel.projections.registrations(id),
    ...services.registrations(id),
  ]
  const ports = bindExtensionInvocations(
    {
      tools: host.kernel.tools,
      hooks,
      slots,
      resources,
      services,
      registrations,
      projections: host.kernel.projections,
    },
    (ref) => host.kernel.get(ref.key),
  )
  const messages: unknown[] = []
  const sink = (...args: unknown[]) => {
    messages.push(args)
    if (options.failSinks) throw new Error('diagnostic failure')
  }
  const loader = createLoader({
    cacheDir: join(root, 'cache'),
    hostRoot: process.cwd(),
    agnesVersion: '0.0.0',
  })
  const managed = createManagedExtHost({
    ports,
    shutdown: async (source, context) => {
      const engine = new HookEngine(
        {
          diag: (name, data) => sink(name, data),
          onFailure: (failure) => sink('hook failure', failure),
          leaseFor: (id) => managed.status().find((status) => status.id === id)?.lease,
          platform,
        },
        hooks,
      )
      await engine.dispatch(
        'shutdown',
        () => ({ reason: context.reason }),
        {
          session: { key: session.key, lane: session.lane, workspaceRoot: session.d.cwd },
          signal: new AbortController().signal,
          replayed: false,
          log: { debug: sink, info: sink, warn: sink, error: sink },
        },
        { snapshot: engine.snapshot(source) },
      )
    },
    loader,
    ceiling: options.ceiling ?? ceiling,
    seamPackages: options.seamPackages ?? new Set(),
    reloadableExtensions: options.reloadableExtensions ?? new Set(),
    info: { agnesVersion: '0.0.0', apiVersion: API_VERSION, profileName: 'test' },
    platform,
    log: { debug: sink, info: sink, warn: sink, error: sink },
    audit: sink,
    ...(options.clock ? { clock: options.clock } : {}),
  })
  held.push({ root, host, managed })
  return { root, host, session, hooks, slots, resources, services, managed, messages }
}

it('loads real TypeScript through jiti into all registries and executes the registered tool on the actual session', async () => {
  const h = await setup()
  const spec = extension(
    h.root,
    'good',
    `import { API_VERSION } from '@agnes/extension-api'; export default (api) => { if(API_VERSION !== api.ctx.info.apiVersion) throw new Error('namespace'); ${body} return () => api.ctx.log.info('disposed') }`,
  )
  expect(await h.managed.load(spec)).toMatchObject({
    id: spec.id,
    package: spec.package,
    version: '1.0.0',
    loaded: true,
    lease: { budget: { remaining: Infinity } },
  })
  expect(h.managed.residue(spec.id)).toHaveLength(4)
  expect(
    (
      await h.slots.snapshot(
        { key: h.session.key, lane: h.session.lane, workspaceRoot: h.session.d.cwd },
        { remainingMs: () => 100 },
      )('tui', { kind: 'tick' })
    )[0]?.payload,
  ).toEqual({ text: 'loaded', level: 'info' })
  await h.session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor: h.session.d.actor })
  expect((await h.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  expect(
    (await h.session.scan({ type: 'x/fixture/good/note', toSeq: h.session.lastSeq })).map((row) => row.data),
  ).toEqual([{ kind: 'tool' }])
  await h.managed.disposeAll()
  expect(h.managed.residue(spec.id)).toEqual([])
  expect(h.managed.status()[0]?.loaded).toBe(false)
})

it('keeps a loaded extension working a year after load, with no lease deadline in reach', async () => {
  const day = 24 * 3600_000
  let now = Date.UTC(2026, 0, 1)
  const start = now
  const h = await setup({ clock: () => now })
  const spec = extension(h.root, 'good', `export default (api) => { ${body} }`)
  expect((await h.managed.load(spec)).loaded).toBe(true)
  for (const at of [start + day + 1, start + 365 * day]) {
    now = at
    expect(Date.parse(h.managed.leaseFor(spec.id)?.expiresAt ?? '')).toBeGreaterThan(now + 50 * 365 * day)
  }
  await h.session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor: h.session.d.actor })
  expect((await h.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  const results = await h.session.scan({ type: 'tool/result', toSeq: h.session.lastSeq })
  expect(JSON.stringify(results.map((row) => row.data))).toContain('"isError":false')
  expect(
    (await h.session.scan({ type: 'x/fixture/good/note', toSeq: h.session.lastSeq })).map((row) => row.data),
  ).toEqual([{ kind: 'tool' }])
})

it('cleans partial registrations after a real factory failure and keeps loading despite failed diagnostic sinks', async () => {
  const h = await setup({ failSinks: true })
  const bad = extension(
    h.root,
    'bad',
    `export default (api) => { ${body} throw new Error('SYNTHETIC-PRIVATE') }`,
  )
  const good = extension(h.root, 'good', `export default (api) => { ${body} }`)
  expect((await h.managed.loadAll([bad, good])).map((s) => s.loaded)).toEqual([false, true])
  expect(h.managed.residue(bad.id)).toEqual([])
  expect(h.managed.residue(good.id)).toHaveLength(4)
  expect(JSON.stringify(h.messages)).not.toContain('SYNTHETIC-PRIVATE')
})

it('admits an injected package factory only after manifest preflight and does not evaluate its static entry', async () => {
  const h = await setup()
  const spec = extension(h.root, 'injected', "throw new Error('static entry must not execute')")
  const status = await h.managed.load(spec, () => (api) => {
    api.registerHook('before_step', () => ({}))
  })
  expect(status).toMatchObject({ id: spec.id, loaded: true, version: '1.0.0' })
  expect(h.hooks.registrations(spec.id)).toEqual(['hook:before_step'])

  const broken = extension(h.root, 'injected-broken', "throw new Error('static entry must not execute')")
  expect(
    await h.managed.load(broken, () => {
      throw new Error('private factory detail')
    }),
  ).toMatchObject({ loaded: false, error: { code: 'E_EXT_LOAD', message: 'extension factory failed' } })
  expect(JSON.stringify(h.messages)).not.toContain('private factory detail')

  const denied = extension(h.root, 'injected-denied', '', {
    ...caps,
    hooks: ['before_step'],
  })
  const noCapabilities = await setup({ ceiling: [] })
  expect(await noCapabilities.managed.load(denied, () => () => undefined)).toMatchObject({
    loaded: false,
    error: { code: 'E_CEILING_EXCEEDED' },
  })
})

it('refuses excess ceiling before real module evaluation and does not inspect disabled paths', async () => {
  const h = await setup({ ceiling: [] }),
    marker = join(h.root, 'evaluated')
  const spec = extension(
    h.root,
    'blocked',
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export default () => {}`,
  )
  const results = await h.managed.loadAll([{ ...spec, enabled: false, dir: join(h.root, 'missing') }, spec])
  expect(() => readFileSync(marker)).toThrow(/ENOENT/)
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ loaded: false, error: { code: 'E_CEILING_EXCEEDED' } })
})

it('keeps the first generation when concurrent loads claim the same identity', async () => {
  const h = await setup(),
    spec = extension(h.root, 'same', `export default (api) => { ${body} }`)
  const statuses = await Promise.all([h.managed.load(spec), h.managed.load(spec)])
  expect(statuses.map((s) => s.loaded)).toEqual([true, false])
  expect(h.managed.status()).toHaveLength(1)
  expect(h.managed.status()[0]?.loaded).toBe(true)
  expect(h.managed.residue(spec.id)).toHaveLength(4)
})

it('closes synchronous factory registration before its queued microtask and retains async factory registration until settlement', async () => {
  const h = await setup()
  const sync = extension(
    h.root,
    'sync',
    `export default (api) => { queueMicrotask(() => { try { api.registerHook('before_step', () => ({})); api.ctx.log.info('late accepted') } catch { api.ctx.log.info('late refused') } }) }`,
  )
  const async = extension(
    h.root,
    'async',
    `export default async (api) => { await Promise.resolve(); api.registerHook('before_step', () => ({})) }`,
  )
  expect((await h.managed.loadAll([sync, async])).map((s) => s.loaded)).toEqual([true, true])
  expect(h.managed.residue(sync.id)).toEqual([])
  expect(h.managed.residue(async.id)).toEqual(['hook:before_step'])
  expect(JSON.stringify(h.messages)).toContain('late refused')
  expect(JSON.stringify(h.messages)).not.toContain('late accepted')
})

it('retains failed cleanup as retryable residue while still removing registrations', async () => {
  const h = await setup(),
    spec = extension(
      h.root,
      'cleanup',
      `export default (api) => { ${body} let first = true; return () => { if(first) { first = false; throw new Error('SYNTHETIC-CLEANUP') } } }`,
    )
  expect((await h.managed.load(spec)).loaded).toBe(true)
  await expect(h.managed.disposeAll()).rejects.toThrow(/E_EXT_LOAD/)
  expect(h.managed.residue(spec.id)).toEqual(['disposer:pending'])
  expect(h.managed.status()[0]?.loaded).toBe(false)
  expect(JSON.stringify(h.messages)).not.toContain('SYNTHETIC-CLEANUP')
  await h.managed.disposeAll()
  expect(h.managed.residue(spec.id)).toEqual([])
  expect((await h.managed.load(spec)).loaded).toBe(false)
})

it.each(['identity', 'api', 'json', 'trust', 'version'] as const)(
  'isolates %s admission failures before real source evaluation',
  async (kind) => {
    const h = await setup(),
      marker = join(h.root, 'evaluated')
    const spec = extension(
      h.root,
      'invalid',
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export default () => {}`,
    )
    if (kind === 'trust') spec.trust = 'community' as ExtensionSpec['trust']
    else if (kind === 'version') spec.packageVersion = ''
    else if (kind === 'identity') spec.id = 'fixture/wrong'
    else if (kind === 'api') {
      const file = join(spec.dir, 'agnes.extension.json')
      const manifest = JSON.parse(readFileSync(file, 'utf8'))
      manifest.apiRange = '^999.0.0'
      writeFileSync(file, JSON.stringify(manifest))
    } else writeFileSync(join(spec.dir, 'agnes.extension.json'), '{invalid')
    const result = await h.managed.load(spec)
    expect(() => readFileSync(marker)).toThrow(/ENOENT/)
    expect(result).toMatchObject({
      loaded: false,
      error: { code: kind === 'api' ? 'E_API_RANGE' : 'E_EXT_LOAD' },
    })
    expect(h.managed.residue(spec.id)).toEqual([])
  },
)

it('revokes all registrations and refuses a retained slot snapshot without leaking the requested reason', async () => {
  const h = await setup(),
    spec = extension(
      h.root,
      'revoked',
      `export default (api) => { api.ctx.signal.addEventListener('abort', () => api.ctx.log.info('signal cancelled')); ${body} }`,
    )
  await h.managed.load(spec)
  const snapshot = h.slots.snapshot(
    { key: h.session.key, lane: h.session.lane, workspaceRoot: h.session.d.cwd },
    { remainingMs: () => 100 },
  )
  expect(await snapshot('tui', { kind: 'tick' })).toHaveLength(1)
  await h.managed.revoke(spec.id, 'SYNTHETIC-PRIVATE-REASON')
  expect(h.managed.residue(spec.id)).toEqual([])
  expect(JSON.stringify(h.messages)).toContain('signal cancelled')
  expect(await snapshot('tui', { kind: 'tick' })).toEqual([])
  expect(h.managed.status()[0]).toMatchObject({ loaded: false, error: { code: 'E_LEASE_EXPIRED' } })
  expect(JSON.stringify([h.managed.status(), h.messages])).not.toContain('SYNTHETIC-PRIVATE-REASON')
  const count = h.messages.length
  await h.managed.revoke(spec.id, 'operator')
  expect(h.messages.length).toBe(count)
})

it('protects the owning seam package even when its extension id differs and the caller mutates its set', async () => {
  const seamPackages = new Set(['@fixture/package']),
    h = await setup({ seamPackages })
  const spec = extension(h.root, 'immutable', `export default (api) => { ${body} }`)
  await h.managed.load(spec)
  seamPackages.clear()
  await expect(h.managed.revoke(spec.id, 'operator')).rejects.toThrow(/E_SEAM_IMMUTABLE/)
  await expect(h.managed.revoke('@fixture/package', 'operator')).rejects.toThrow(/E_SEAM_IMMUTABLE/)
  expect(h.managed.residue(spec.id)).toHaveLength(4)
  expect(h.managed.status()[0]?.loaded).toBe(true)
})

// Task 3b (resource-live-reload): the narrow allowlist that exempts an explicitly named extension id
// from the seam-owning-package guard above, so reloadEcosystemExtension can reach
// agnes/skills in production even though @agnes/base supplies almost every seam. This proves the
// allowlist actually lets an allowlisted id through revoke() - the only remaining guard site - while
// its package remains seam-protected for everything else.
it('lets an allowlisted extension id be revoked even though its owning package supplies a seam', async () => {
  const seamPackages = new Set(['@fixture/package']),
    h = await setup({ seamPackages, reloadableExtensions: new Set(['fixture/allowlisted']) })
  const spec = extension(h.root, 'allowlisted', `export default (api) => { ${body} }`)
  await h.managed.load(spec)
  await expect(h.managed.revoke(spec.id, 'operator')).resolves.toBeUndefined()
  expect(h.managed.status()[0]).toMatchObject({ loaded: false, error: { code: 'E_LEASE_EXPIRED' } })
  // The package identity itself, not named in reloadableExtensions, stays exactly as protected.
  await expect(h.managed.revoke('@fixture/package', 'operator')).rejects.toThrow(/E_SEAM_IMMUTABLE/)
})

// Design 2026-09-21-resource-rows-design.md §3.7 (D119): a Host-owned dynamic row registers when its
// resource is ready (an MCP connection landing, a reconnect, tools/list_changed), not only while its
// factory runs, and must unmount even when its owning package supplies a seam. Both are opt-in per
// load; an ordinary load keeps the factory-only window and the seam veto.
function embedded(h: { root: string }, name: string) {
  const spec: ExtensionSpec = {
    id: `fixture/${name}`,
    package: '@fixture/package',
    packageVersion: '1.0.0',
    dir: h.root,
    trust: 'builtin',
    enabled: true,
  }
  const manifest: ExtensionManifest = {
    id: spec.id,
    version: '1.0.0',
    apiRange: `^${API_VERSION}`,
    entry: './index.ts',
    capabilities: { tools: { prefix: 'fx_' }, resources: ['skill'] },
  } as ExtensionManifest
  const captured: { api?: ExtensionAPI } = {}
  const factory = () => (api: ExtensionAPI) => {
    captured.api = api
  }
  return { spec, manifest, factory, captured }
}

it('keeps registration open after the factory only for a lifetime-window load, and closes it on revoke', async () => {
  const h = await setup()
  const dynamic = embedded(h, 'dynamic')
  const ordinary = embedded(h, 'ordinary')
  await h.managed.loadEmbedded(dynamic.spec, dynamic.manifest, dynamic.factory, { registration: 'lifetime' })
  await h.managed.loadEmbedded(ordinary.spec, ordinary.manifest, ordinary.factory)

  const skill = (id: string) => ({ id, kind: 'skill' as const, name: id, description: id })
  dynamic.captured.api?.registerTool(fixtureTool('fx_late'))
  dynamic.captured.api?.registerResource(skill('late'))
  expect(h.host.kernel.tools.resolve('fx_late')).toBeDefined()
  expect(h.resources.registrations(dynamic.spec.id)).toHaveLength(1)
  expect(() => ordinary.captured.api?.registerTool(fixtureTool('fx_other'))).toThrow(
    /registration outside factory/,
  )
  expect(h.host.kernel.tools.resolve('fx_other')).toBeUndefined()

  await h.managed.revoke(dynamic.spec.id, 'operator')
  // The late registration was released with the extension, and nothing registers after revoke.
  expect(h.host.kernel.tools.resolve('fx_late')).toBeUndefined()
  expect(h.managed.residue(dynamic.spec.id)).toEqual([])
  expect(() => dynamic.captured.api?.registerTool(fixtureTool('fx_after'))).toThrow()
  expect(h.host.kernel.tools.resolve('fx_after')).toBeUndefined()
  // A resource has no lease-scope check of its own: only the liveness check stops this one.
  expect(() => dynamic.captured.api?.registerResource(skill('after'))).toThrow()
  expect(h.resources.registrations(dynamic.spec.id)).toEqual([])
})

it('reports registration changes made after the factory returned, coalesced per microtask', async () => {
  const h = await setup()
  const dynamic = embedded(h, 'dynamic')
  let notified = 0
  const factory = () => (api: ExtensionAPI) => {
    dynamic.captured.api = api
    api.registerTool(fixtureTool('fx_during'))
  }
  await h.managed.loadEmbedded(dynamic.spec, dynamic.manifest, factory, {
    registration: 'lifetime',
    onLateRegistration: () => {
      notified++
    },
  })
  await Promise.resolve()
  // What the factory registered is published with the load itself.
  expect(notified).toBe(0)

  const one = dynamic.captured.api?.registerTool(fixtureTool('fx_one'))
  dynamic.captured.api?.registerTool(fixtureTool('fx_two'))
  await Promise.resolve()
  expect(notified).toBe(1)
  await one?.()
  await Promise.resolve()
  expect(notified).toBe(2)
})

it('exempts only a record loaded as reloadable from the seam veto, not its package siblings', async () => {
  const h = await setup({ seamPackages: new Set(['@fixture/package']) })
  const dynamic = embedded(h, 'dynamic')
  const sibling = embedded(h, 'sibling')
  await h.managed.loadEmbedded(dynamic.spec, dynamic.manifest, dynamic.factory, { reloadable: true })
  await h.managed.loadEmbedded(sibling.spec, sibling.manifest, sibling.factory)

  await expect(h.managed.revoke(dynamic.spec.id, 'operator')).resolves.toBeUndefined()
  await expect(h.managed.revoke(sibling.spec.id, 'operator')).rejects.toThrow(/E_SEAM_IMMUTABLE/)
  await expect(h.managed.revoke('@fixture/package', 'operator')).rejects.toThrow(/E_SEAM_IMMUTABLE/)
})

it('keeps a failed revoke cleanup visible and retries without reactivating the lease', async () => {
  const h = await setup(),
    spec = extension(
      h.root,
      'retry-revoke',
      `export default (api) => { ${body} let first = true; return () => { if(first) { first = false; throw new Error('cleanup') } } }`,
    )
  await h.managed.load(spec)
  await expect(h.managed.revoke(spec.id, 'operator')).rejects.toThrow(/E_EXT_LOAD/)
  expect(h.managed.status()[0]).toMatchObject({ loaded: false, error: { code: 'E_LEASE_EXPIRED' } })
  expect(h.managed.residue(spec.id)).toEqual(['disposer:pending'])
  await h.managed.revoke(spec.id, 'operator')
  expect(h.managed.residue(spec.id)).toEqual([])
})

it('runs only the revoked extension cleanup with real session identity, no restored authority, and disposer last', async () => {
  const h = await setup()
  const target = extension(
    h.root,
    'shutdown-target',
    `export default (api) => {
    api.registerHook('shutdown', async (payload, context) => {
      api.ctx.log.info('shutdown observed', { reason: payload.reason, session: context.session.key, cleanupAborted: context.signal.aborted, authorAborted: api.ctx.signal.aborted });
      try { await api.events.append('note', {}) } catch { api.ctx.log.info('write refused') }
    });
    return () => api.ctx.log.info('disposer last');
  }`,
    { hooks: ['shutdown'], events: true },
  )
  const other = extension(
    h.root,
    'shutdown-other',
    `export default (api) => { api.registerHook('shutdown', () => api.ctx.log.info('wrong target')) }`,
    { hooks: ['shutdown'] },
  )
  await h.managed.loadAll([target, other])
  const before = h.messages.length
  await h.managed.revoke(target.id, 'operator')
  const output = h.messages.slice(before)
  expect(await h.session.scan({ type: 'x/fixture/shutdown-target/note', toSeq: h.session.lastSeq })).toEqual(
    [],
  )
  expect(output[0]).toEqual([
    'shutdown observed',
    { reason: 'revoke', session: 'managed', cleanupAborted: false, authorAborted: true },
  ])
  expect(output[1]).toEqual(['write refused'])
  expect(output[2]).toEqual(['disposer last'])
  expect(JSON.stringify(output)).not.toContain('wrong target')
  expect(h.managed.residue(target.id)).toEqual([])
  expect(h.managed.residue(other.id)).toEqual(['hook:shutdown'])
})

it('continues real revoke cleanup at the protocol deadline when an extension shutdown hangs', async () => {
  const h = await setup()
  const target = extension(
    h.root,
    'hung-shutdown',
    `export default (api) => {
    api.registerHook('shutdown', async () => { api.ctx.log.info('shutdown entered'); await new Promise(() => {}) });
    return () => api.ctx.log.info('disposer ran');
  }`,
    { hooks: ['shutdown'] },
  )
  await h.managed.load(target)
  vi.useFakeTimers()
  try {
    let done = false
    const pending = h.managed.revoke(target.id, 'operator').then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(JSON.stringify(h.messages)).toContain('shutdown entered')
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(JSON.stringify(h.messages)).toContain('disposer ran')
    expect(h.managed.residue(target.id)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('continues disposer cleanup after a real shutdown handler throws without exposing its error', async () => {
  const h = await setup()
  const target = extension(
    h.root,
    'throwing-shutdown',
    `export default (api) => {
    api.registerHook('shutdown', () => { throw new Error('SYNTHETIC-SHUTDOWN-PRIVATE') });
    return () => api.ctx.log.info('cleanup finished');
  }`,
    { hooks: ['shutdown'] },
  )
  await h.managed.load(target)
  await h.managed.revoke(target.id, 'operator')
  expect(h.managed.residue(target.id)).toEqual([])
  expect(JSON.stringify(h.messages)).toContain('cleanup finished')
  expect(JSON.stringify(h.messages)).not.toContain('SYNTHETIC-SHUTDOWN-PRIVATE')
})

it('refuses a trusted third-party extension through the managed host', async () => {
  const h = await setup()
  const spec = extension(h.root, 'retired-third-party', 'export default () => {}')
  const status = await h.managed.load({ ...spec, trust: 'trusted' })
  expect(status.loaded).toBe(false)
  expect(status.error?.code).toBe('E_EXT_LOAD')
})
it('loads a real Projection author module, reads through Slot and purges it on managed revoke', async () => {
  const h = await setup({ ceiling: ['projections', 'slots', 'events'] })
  const spec = extension(
    h.root,
    'projection',
    `export default (api) => {
    api.registerProjection({name: 'count', stateVersion: 1, stateSchema: {type: 'integer'}, init: () => 0, apply: (s) => s + 1});
    api.registerSlot('status.line', async (ctx) => {
      await api.events.append('note', {});
      const r = await ctx.projections.readOwn('count');
      return {text: r.status === 'available' ? String(r.value) : 'unavailable', level: 'info'};
    });
  }`,
    {
      projections: [{ name: 'count', inputEventTypes: ['x/fixture/projection/note'], maxStateBytes: 1024 }],
      slots: ['status.line'],
      events: true,
    },
  )
  expect((await h.managed.load(spec)).loaded).toBe(true)
  const run = () =>
    h.slots.snapshot(
      { key: h.session.key, lane: h.session.lane, workspaceRoot: h.session.d.cwd },
      { remainingMs: () => 1000 },
    )('tui', {
      kind: 'tick',
    })
  expect((await run())[0]?.payload).toEqual({ text: '1', level: 'info' })
  expect(h.host.kernel.projections.cacheLine(h.session.key, 'fixture/projection/count')).toBeDefined()
  await h.managed.revoke(spec.id, 'operator')
  expect(h.managed.residue(spec.id)).toEqual([])
  expect(h.host.kernel.projections.cacheLine(h.session.key, 'fixture/projection/count')).toBeUndefined()
  expect(h.host.kernel.projections.failures()).toEqual([])
  expect(await run()).toEqual([])
})

it('checks the Projection capability ceiling before evaluating author code', async () => {
  const h = await setup()
  const spec = extension(
    h.root,
    'ceiling-projection',
    `throw new Error('author module evaluated'); export default () => {};`,
    {
      projections: [{ name: 'count', inputEventTypes: ['turn/start'], maxStateBytes: 1024 }],
    },
  )
  expect(await h.managed.load(spec)).toMatchObject({ loaded: false, error: { code: 'E_CEILING_EXCEEDED' } })
  expect(h.host.kernel.projections.registrations(spec.id)).toEqual([])
})
