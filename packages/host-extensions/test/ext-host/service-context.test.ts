import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bindChildFactory,
  type ChildControlStore,
  type ChildTaskRecord,
  type KernelChildren,
  type SeamImplementations,
  trackExternalChild,
  unbindChildFactory,
  type WorkspaceInvocationView,
} from '@agnes/core'
import { fakeSeams } from '@agnes/core/testkit'
import type { ExtensionManifest, ServiceContext } from '@agnes/extension-api'
import { serviceFixture } from '@agnes/extension-api/testkit'
import { createSqliteStorage } from '@agnes/host-infrastructure/adapters/storage-sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { leaseFor } from '../../src/ext-host/lease.js'
import { serviceContext } from '../../src/ext-host/service-context.js'
import { ServiceRegistry } from '../../src/ext-host/services.js'

afterEach(() => vi.unstubAllGlobals())
// `platform` overrides the fake platform seam (default facts/capability otherwise), so a test can
// make the seam's answer change between two context-builder invocations.
function fixture(
  platform?: Partial<SeamImplementations['platform']>,
  authorizeProcess?: Parameters<typeof serviceContext>[0]['authorizeProcess'],
) {
  const def = serviceFixture(),
    { handler: _, ...cap } = def
  const manifest: ExtensionManifest = {
    id: 'fixture/service',
    version: '1.0.0',
    apiRange: '^5.0.0',
    entry: './index.js',
    capabilities: { services: [cap], network: ['allowed.test:443', 'only-manifest.test'] },
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
  const build = serviceContext({
    seams,
    networkAllow: ['allowed.test', 'only-policy.test'],
    log,
    ...(authorizeProcess ? { authorizeProcess } : {}),
  })
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

it('binds process launch and child cancellation only to journaled effects and Host session identity', async () => {
  const { build, entry, identity, alive, workspace } = fixture()
  const openProcess = async () => {
    throw new Error('process backend reached')
  }
  const boundWorkspace = {
    ...workspace,
    hookSandbox: () => ({
      enforcement: () => ({ level: 'none' as const, scope: [] }),
      exec: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
      openProcess,
    }),
  }
  const { handler: _handler, ...effectCapability } = serviceFixture()
  const session = { key: 'session-bound-by-host', lane: 'main', workspaceRoot: workspace.root }
  const query = build(entry, { ...identity, session }, alive, boundWorkspace)
  expect(query.session?.key).toBe(session.key)
  expect(query.sandbox).toBeUndefined()
  expect(query.childJobs?.cancel).toBeUndefined()
  const effect = build(
    { ...entry, capability: { ...effectCapability, kind: 'effect' } },
    { ...identity, session },
    alive,
    boundWorkspace,
  )
  await expect(effect.sandbox!.openProcess!({ argv: ['bash'], cwd: workspace.root })).rejects.toThrow(
    'service operation unavailable',
  )
  const approved = fixture(undefined, async () => {}).build(
    { ...entry, capability: { ...effectCapability, kind: 'effect' } },
    { ...identity, session },
    alive,
    boundWorkspace,
  )
  await expect(approved.sandbox!.openProcess!({ argv: ['bash'], cwd: workspace.root })).rejects.toThrow(
    'process backend reached',
  )
  const denied = fixture(undefined, async () => {
    throw new Error('preset denied')
  }).build(
    { ...entry, capability: { ...effectCapability, kind: 'effect' } },
    { ...identity, session },
    alive,
    boundWorkspace,
  )
  await expect(denied.sandbox!.openProcess!({ argv: ['bash'], cwd: workspace.root })).rejects.toThrow(
    'preset denied',
  )
})

function childRecord(
  childKey: string,
  parentKey: string,
  state: ChildTaskRecord['state'] = 'running',
  stateRevision = 1,
  inputText = `task ${childKey}`,
  runtimeOwnerSessionKey = parentKey,
): ChildTaskRecord {
  return {
    childKey,
    creationId: `c:${childKey}`,
    attemptId: `a:${childKey}`,
    creationPhase: 'committed',
    creationRevision: 1,
    attemptStartedAt: 1,
    parentKey,
    rootTaskId: runtimeOwnerSessionKey,
    runtimeOwnerSessionKey,
    kind: 'spawn',
    generationDepth: runtimeOwnerSessionKey === parentKey ? 1 : 2,
    generationLimit: 4,
    boundarySeq: 1,
    inputHash: `h:${childKey}`,
    inputText,
    cwd: '/workspace',
    actorId: 'subject',
    budgetScopeId: `b:${childKey}`,
    ancestorScopeIds: [],
    workspaceId: null,
    isolation: 'shared',
    state,
    stateRevision,
    controlFormat: 4,
  }
}

it('distinguishes direct vs read-only descendants, refuses grandchild/ambiguous cancel without touching ports, and reads bodies on demand', async () => {
  const { build, entry, identity, alive, workspace } = fixture()
  const { handler: _handler, ...effectCapability } = serviceFixture()
  const rootKey = 'root-child-jobs-test'
  const childKey = 'direct-child-1'
  const grandKey = 'grandchild-1'
  const dupKey = 'shared-raw-id'
  const emojiSplitKey = 'emoji-split-child'
  const emojiFitKey = 'emoji-fit-child'

  const records = new Map<string, ChildTaskRecord>([
    [childKey, childRecord(childKey, rootKey, 'waiting_approval', 2, 'Direct child task')],
    [dupKey, childRecord(dupKey, rootKey, 'running', 3, 'Local colliding child')],
    // Real SQLite grandchildren persist parentKey=direct-child-1 and runtimeOwnerSessionKey=rootKey.
    [grandKey, childRecord(grandKey, childKey, 'paused', 7, 'Paused grandchild task', rootKey)],
    [emojiSplitKey, childRecord(emojiSplitKey, rootKey, 'running', 1, `${'a'.repeat(79)}🚀tail`)],
    [emojiFitKey, childRecord(emojiFitKey, rootKey, 'running', 1, `${'a'.repeat(78)}🚀tail`)],
  ])
  const store = {
    listByParent: vi.fn(async (parentKey: string) =>
      [...records.values()].filter((row) => row.parentKey === parentKey),
    ),
    lookupByKey: vi.fn(async (key: string) => records.get(key)),
  } as unknown as ChildControlStore

  const rootCancel = vi.fn(async (id: string) => {
    const rec = records.get(id)
    if (rec) records.set(id, { ...rec, state: 'cancelled', stateRevision: rec.stateRevision + 1 })
  })
  const childCancel = vi.fn(async (id: string) => {
    const rec = records.get(id)
    if (rec) records.set(id, { ...rec, state: 'cancelled', stateRevision: rec.stateRevision + 1 })
  })
  const rootInspect = vi.fn(async (id: string) => ({ state: 'running', text: `body:${id}` }))
  const childInspect = vi.fn(async (id: string) => ({ state: 'paused', text: `grand-body:${id}` }))
  const rootList = vi.fn(async () => {
    throw new Error('full backend.list() should not run when ChildControlStore is present')
  })
  const externalDupCancel = vi.fn(async () => {})
  const externalOnlyCancel = vi.fn(async () => {})

  const rootBackend = {
    childEvents: { store },
    list: rootList,
    inspect: rootInspect,
    cancel: rootCancel,
  } as unknown as KernelChildren
  const directChildBackend = {
    childEvents: { store },
    list: rootList,
    inspect: childInspect,
    cancel: childCancel,
  } as unknown as KernelChildren

  bindChildFactory(rootKey, rootBackend)
  bindChildFactory(childKey, directChildBackend)
  const untrackDup = trackExternalChild(rootKey, {
    listing: {
      id: dupKey,
      providerId: 'acp',
      status: 'running',
      continuable: true,
      text: 'external dup body',
    },
    cancel: externalDupCancel,
  })
  const untrackExt = trackExternalChild(rootKey, {
    listing: {
      id: 'ext-only',
      providerId: 'acp',
      status: 'running',
      continuable: true,
      text: 'external only body',
    },
    cancel: externalOnlyCancel,
  })

  try {
    const boundWorkspace = {
      ...workspace,
      hookSandbox: () => ({
        enforcement: () => ({ level: 'none' as const, scope: [] }),
        exec: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
      }),
    }
    const session = { key: rootKey, lane: 'main', workspaceRoot: workspace.root }
    const effect = build(
      { ...entry, capability: { ...effectCapability, kind: 'effect' } },
      { ...identity, session },
      alive,
      boundWorkspace,
    )
    const port = effect.childJobs as NonNullable<typeof effect.childJobs> & {
      readDetail(id: string): Promise<Record<string, unknown> | undefined>
      cancel(id: string, target?: { providerId?: string; ownerSessionId?: string }): Promise<void>
    }

    // Lightweight list reads metadata only (zero inspect calls, zero text bodies).
    const listed = (await port.list()) as readonly Record<string, unknown>[]
    expect(rootInspect).not.toHaveBeenCalled()
    expect(childInspect).not.toHaveBeenCalled()
    expect(rootList).not.toHaveBeenCalled()
    expect(listed.find((row) => row.id === childKey)).toMatchObject({
      id: childKey,
      ownerSessionId: rootKey,
      direct: true,
      readOnly: false,
      ambiguous: false,
      status: 'waiting_approval',
      label: 'Direct child task',
    })
    expect(listed.find((row) => row.id === grandKey)).toMatchObject({
      id: grandKey,
      ownerSessionId: childKey,
      direct: false,
      readOnly: true,
      status: 'paused',
    })
    expect(listed.find((row) => row.id === dupKey)).toMatchObject({
      id: dupKey,
      direct: false,
      readOnly: true,
      ambiguous: true,
    })
    // UTF-16 surrogate-pair safe label truncation (#31): never splits an emoji at index 80.
    expect(listed.find((row) => row.id === emojiSplitKey)?.label).toBe('a'.repeat(79))
    expect(listed.find((row) => row.id === emojiFitKey)?.label).toBe(`${'a'.repeat(78)}🚀`)
    expect(listed.every((row) => row.text === undefined)).toBe(true)

    // On-demand detail read inspects ONLY the requested child and agrees with list() on owner/readOnly.
    const grandDetail = await port.readDetail(grandKey)
    expect(grandDetail).toMatchObject({
      id: grandKey,
      ownerSessionId: childKey,
      direct: false,
      readOnly: true,
      text: `grand-body:${grandKey}`,
    })
    expect(childInspect).toHaveBeenCalledTimes(1)
    expect(childInspect).toHaveBeenCalledWith(grandKey)
    expect(rootInspect).not.toHaveBeenCalled()

    // Negative contract 1: cancelling a read-only grandchild (even when runtimeOwnerSessionKey === rootKey)
    // fails closed without touching any cancel port or revision.
    await expect(port.cancel(grandKey)).rejects.toThrow('CAPABILITY_DENIED')
    expect(rootCancel).not.toHaveBeenCalled()
    expect(childCancel).not.toHaveBeenCalled()
    expect(records.get(grandKey)?.stateRevision).toBe(7)

    // Negative contract 2: cancelling an ambiguous raw ID fails closed without touching local or external cancel ports.
    await expect(port.cancel(dupKey)).rejects.toThrow('CAPABILITY_DENIED')
    expect(rootCancel).not.toHaveBeenCalled()
    expect(externalDupCancel).not.toHaveBeenCalled()
    expect(records.get(dupKey)?.stateRevision).toBe(3)

    // Negative contract 3: mismatched owner or provider is refused before touching cancel ports.
    await expect(port.cancel(childKey, { providerId: 'acp' })).rejects.toThrow('CAPABILITY_DENIED')
    await expect(port.cancel(childKey, { ownerSessionId: 'foreign-session' })).rejects.toThrow(
      'CAPABILITY_DENIED',
    )
    expect(rootCancel).not.toHaveBeenCalled()
    expect(records.get(childKey)?.stateRevision).toBe(2)

    // Positive contract: unambiguous direct children with matching identity cancel cleanly.
    await port.cancel(childKey, { providerId: 'in-process', ownerSessionId: rootKey })
    expect(rootCancel).toHaveBeenCalledTimes(1)
    expect(rootCancel).toHaveBeenCalledWith(childKey)
    await port.cancel('ext-only', { providerId: 'acp', ownerSessionId: rootKey })
    expect(externalOnlyCancel).toHaveBeenCalledTimes(1)
  } finally {
    untrackDup()
    untrackExt()
    unbindChildFactory(rootKey, rootBackend)
    unbindChildFactory(childKey, directChildBackend)
  }
})

it('uses durable parentKey rather than runtimeOwnerSessionKey after real SQLite reopen for grandchild jobs access (P1-A)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-service-context-sqlite-'))
  const storageArgs = { file: join(dir, 'records.db'), tablesDir: join(dir, 'tables') }
  const rootKey = 'sqlite-root-session'
  const parentKey = 'sqlite-parent-child'
  const grandKey = 'sqlite-grand-child'

  const initial = createSqliteStorage(storageArgs)
  try {
    await initial.open(rootKey, { writerRunId: 'root-writer', ttlMs: 60_000 })
    await initial.ensureRootScope(rootKey, 10_000_000n)
    for (const [ownerKey, key, depth] of [
      [rootKey, parentKey, 1],
      [parentKey, grandKey, 2],
    ] as const) {
      const created = await initial.createDelegatedChild({
        childKey: key,
        parentKey: ownerKey,
        runtimeOwnerSessionKey: ownerKey,
        rootTaskId: rootKey,
        generationDepth: depth,
        generationLimit: 3,
        boundarySeq: 0,
        creationId: key,
        kind: 'spawn',
        maxFanOut: 4,
        inputHash: key,
        inputText: `task ${key}`,
        cwd: '/workspace',
        actorId: 'subject',
        isolation: 'shared',
        workspaceId: key,
        treeCapMicro: 10_000_000n,
        childCapMicro: null,
        writerRunId: key,
      })
      expect(created.status).toBe('created')
    }
  } finally {
    await initial.close()
  }

  const reopened = createSqliteStorage(storageArgs)
  const { build, entry, identity, alive, workspace } = fixture()
  const { handler: _handler, ...effectCapability } = serviceFixture()
  const rootCancel = vi.fn(async () => {})
  const parentCancel = vi.fn(async () => {})
  const parentInspect = vi.fn(async (id: string) => ({ state: 'running', text: `sqlite-body:${id}` }))
  const rootBackend = {
    childEvents: { store: reopened },
    list: vi.fn(async () => []),
    inspect: vi.fn(async () => undefined),
    cancel: rootCancel,
  } as unknown as KernelChildren
  const parentBackend = {
    childEvents: { store: reopened },
    list: vi.fn(async () => []),
    inspect: parentInspect,
    cancel: parentCancel,
  } as unknown as KernelChildren

  bindChildFactory(rootKey, rootBackend)
  bindChildFactory(parentKey, parentBackend)

  try {
    const persisted = await reopened.lookupByKey(grandKey)
    expect(persisted).toMatchObject({ parentKey, runtimeOwnerSessionKey: rootKey })
    const initialRevision = persisted?.stateRevision

    const boundWorkspace = {
      ...workspace,
      hookSandbox: () => ({
        enforcement: () => ({ level: 'none' as const, scope: [] }),
        exec: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
      }),
    }
    const portFor = (sessionKey: string) =>
      build(
        { ...entry, capability: { ...effectCapability, kind: 'effect' } },
        { ...identity, session: { key: sessionKey, lane: 'main', workspaceRoot: workspace.root } },
        alive,
        boundWorkspace,
      ).childJobs as NonNullable<ServiceContext['childJobs']> & {
        readDirect(id: string): Promise<Record<string, unknown> | undefined>
        readDetail(id: string): Promise<Record<string, unknown> | undefined>
        cancel(id: string, target?: { providerId?: string; ownerSessionId?: string }): Promise<void>
      }

    const rootPort = portFor(rootKey)
    const rootList = (await rootPort.list()) as readonly Record<string, unknown>[]
    const listedGrand = rootList.find((row) => row.id === grandKey)
    const detailGrand = await rootPort.readDetail(grandKey)
    expect(listedGrand).toMatchObject({
      id: grandKey,
      ownerSessionId: parentKey,
      direct: false,
      readOnly: true,
      ambiguous: false,
    })
    expect(detailGrand).toMatchObject({
      id: grandKey,
      ownerSessionId: parentKey,
      direct: false,
      readOnly: true,
      ambiguous: false,
      text: `sqlite-body:${grandKey}`,
    })
    expect(await rootPort.readDirect(grandKey)).toBeUndefined()
    await expect(rootPort.cancel(grandKey)).rejects.toThrow('CAPABILITY_DENIED')
    expect(rootCancel).not.toHaveBeenCalled()
    expect(parentCancel).not.toHaveBeenCalled()
    expect((await reopened.lookupByKey(grandKey))?.stateRevision).toBe(initialRevision)

    // Direct parent retains full direct ownership and cancellation rights.
    const parentPort = portFor(parentKey)
    expect(await parentPort.readDirect(grandKey)).toMatchObject({
      id: grandKey,
      ownerSessionId: parentKey,
      direct: true,
      readOnly: false,
      ambiguous: false,
    })
    expect(await parentPort.readDetail(grandKey)).toMatchObject({
      id: grandKey,
      ownerSessionId: parentKey,
      direct: true,
      readOnly: false,
      text: `sqlite-body:${grandKey}`,
    })
    await parentPort.cancel(grandKey, { providerId: 'in-process', ownerSessionId: parentKey })
    expect(parentCancel).toHaveBeenCalledTimes(1)
    expect(parentCancel).toHaveBeenCalledWith(grandKey)
  } finally {
    unbindChildFactory(rootKey, rootBackend)
    unbindChildFactory(parentKey, parentBackend)
    await reopened.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
