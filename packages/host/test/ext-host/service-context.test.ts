import type { SeamImplementations, WorkspaceInvocationView } from '@agnes/core'
import { fakeSeams } from '@agnes/core/testkit'
import type { ExtensionManifest, ServiceContext } from '@agnes/extension-api'
import { serviceFixture } from '@agnes/extension-api/testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { leaseFor } from '../../src/ext-host/lease.js'
import { serviceContext } from '../../src/ext-host/service-context.js'
import { ServiceRegistry } from '../../src/ext-host/services.js'

afterEach(() => vi.unstubAllGlobals())
// `platform` overrides the fake platform seam (default facts/capability otherwise), so a test can
// make the seam's answer change between two context-builder invocations.
function fixture(platform?: Partial<SeamImplementations['platform']>) {
  const def = serviceFixture(),
    { handler: _, ...cap } = def
  const manifest: ExtensionManifest = {
    id: 'fixture/service',
    version: '1.0.0',
    apiRange: '^1.0',
    entry: './index.js',
    capabilities: { services: [cap], network: { hosts: ['allowed.test:443', 'only-manifest.test'] } },
  }
  const registry = new ServiceRegistry(),
    ac = new AbortController()
  registry.register(def, {
    manifest,
    lease: leaseFor(manifest, { now: Date.now(), ttlMs: 1000 }),
    signal: ac.signal,
  })
  const entry = registry.resolve(manifest.id, def.name)
  if (!entry) throw new Error('missing fixture')
  const workspace = {
    root: '/workspace',
    fs: () => ({
      read: async () => new Uint8Array(),
      list: async () => [],
      stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
    }),
    ready: async () => ({ confine: async (argv: readonly string[]) => argv }),
    hookSnapshot: async () => ({ workspaceDigest: 'workspace', policyRevision: 1, hooks: [] }),
    approvalContext: () => ({}),
    checkpointContext: () => ({}),
  } as unknown as WorkspaceInvocationView
  const seams = fakeSeams(platform ? { platform } : {}),
    log = { debug() {}, info() {}, warn() {}, error() {} }
  const identity: Pick<ServiceContext, 'actor' | 'source' | 'requestId' | 'signal' | 'timeoutMs'> = {
    actor: { id: 'subject', org: '', role: '', deptPath: [], attrs: {} },
    source: 'surface',
    requestId: 'request',
    signal: ac.signal,
    timeoutMs: 1000,
  }
  const alive = () => {
    if (ac.signal.aborted) throw new Error('closed')
  }
  // `build` is exactly `ServiceInvocationDeps['context']` -- assemble.ts constructs it once
  // (`context: serviceContext({...})`) and service-invocation.ts's `run()` calls it once per
  // service invocation (`deps.context(entry, {...}, alive)`). Exposing it lets a test call it
  // more than once, the same way production does across two separate calls.
  const build = serviceContext({ seams, networkAllow: ['allowed.test', 'only-policy.test'], log })
  const ctx = build(entry, identity, alive, workspace)
  return { ctx, ac, seams, build, entry, identity, alive, workspace }
}

it('requires both manifest and sandbox network grants, safe methods and no redirects', async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'))
  vi.stubGlobal('fetch', fetch)
  const { ctx, ac } = fixture()
  await ctx.net.fetch('https://allowed.test/read', { dispatcher: 'author-controlled' } as never)
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
  expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('dispatcher')
  for (const url of [
    'http://allowed.test/read',
    'https://only-manifest.test',
    'https://only-policy.test',
    'https://user:password@allowed.test',
    'file:///etc/passwd',
  ])
    await expect(ctx.net.fetch(url)).rejects.toThrow()
  await expect(ctx.net.fetch('https://allowed.test', { method: 'POST' })).rejects.toThrow()
  await expect(ctx.net.fetch('https://allowed.test', { body: 'payload' })).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(1)
  const signal = fetch.mock.calls[0]?.[1]?.signal
  ac.abort()
  expect(signal?.aborted).toBe(true)
  await expect(ctx.net.fetch('https://allowed.test')).rejects.toThrow(/closed/)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('validates authorize requests and responses without pretending Core JobStatus compatibility', async () => {
  const { ctx, seams } = fixture()
  const authorize = vi.spyOn(seams.principals, 'authorize')
  await expect(ctx.authorize('execute', { kind: 'datasource', id: 'data' })).resolves.toMatchObject({
    effect: 'allow',
  })
  await expect(ctx.authorize('wildcard' as never, { kind: 'datasource', id: 'data' })).rejects.toThrow()
  expect(authorize).toHaveBeenCalledTimes(1)
  authorize.mockResolvedValue({
    decisionId: 'bad',
    effect: 'allow',
    reason: '',
    rowFilter: 'invalid public row scope',
  })
  await expect(ctx.authorize('execute', { kind: 'datasource', id: 'data' })).rejects.toThrow()
  expect(() => ctx.artifacts.poll('job')).toThrow(/unavailable/)
})

it('exposes a read-only platform view read from seams.platform at call time, and no sandbox (spec §5.1)', () => {
  const { ctx, seams } = fixture()
  expect(ctx.platform.shell).toBe(seams.platform.shell())
  expect(ctx.platform.fs).toEqual({ caseSensitive: true, pathSep: '/' })
  expect(ctx.platform.capability('anything')).toEqual({ level: 'full', scope: [] })
  expect(Object.isFrozen(ctx.platform)).toBe(true)
  expect(Object.keys(ctx).sort()).toEqual([
    'actor',
    'artifacts',
    'authorize',
    'cwd',
    'exec',
    'fs',
    'log',
    'net',
    'platform',
    'requestId',
    'signal',
    'source',
    'timeoutMs',
  ])
})

it('probes capability() live on every call, never memoized from the first (spec §5.1)', () => {
  let calls = 0
  const { ctx } = fixture({
    capability: () => {
      calls++
      return calls === 1 ? { level: 'full', scope: [] } : { level: 'partial', scope: ['file'] }
    },
  })
  expect(ctx.platform.capability('anything')).toEqual({ level: 'full', scope: [] })
  expect(ctx.platform.capability('anything')).toEqual({ level: 'partial', scope: ['file'] })
  expect(calls).toBe(2)
})

// Mirror of Task 2's Kernel test (core/test/kernel.test.ts): there, platform must be the SAME
// object across two sessions (computed once). Here it is the opposite requirement: platform must
// be a DIFFERENT, freshly-probed object across two service invocations sharing one `serviceContext`
// construction -- exactly how assemble.ts wires it (`context: serviceContext({...})`, called once,
// then invoked once per call by service-invocation.ts's `run()`). `capability()` alone cannot prove
// this: PlatformView.capability() always delegates live to the seam regardless of when
// platformView() was constructed (see platform-facts.ts), so it would look fresh even if someone
// hoisted `platformView(deps.seams.platform)` out of the per-invocation closure and cached the
// whole object. The `shell`/`fs`/`terminal` facts are the part `platformFacts()` snapshots once
// per `platformView()` call, so they are what actually goes stale under that regression -- proving
// freshness there is what catches it.
it('builds platform fresh inside the per-call context builder, not once when serviceContext() is constructed (spec §5.1)', () => {
  // Flips on every actual seam.shell() call (not tied to an absolute call count, since `fixture()`
  // itself already invokes `build` once to hand back `ctx` for the other tests): a fresh-per-call
  // implementation calls shell() once per `build(...)`, so two explicit calls here see opposite
  // values; a hoisted/cached implementation calls shell() once ever (whenever platformView() first
  // runs) and both explicit calls would see that same single cached value.
  let posix = true
  const { build, entry, identity, alive, workspace } = fixture({
    shell: () => {
      posix = !posix
      return posix ? 'posix' : 'powershell'
    },
  })
  const first = build(entry, identity, alive, workspace)
  const second = build(entry, identity, alive, workspace)
  expect(first.platform.shell).not.toBe(second.platform.shell)
  expect(first.platform).not.toBe(second.platform)
})
