import { type CurrentSessionRuntime, noopHooks, ToolRegistry } from '@agnes/core'
import {
  buildRuntimeTarget,
  createPluginRow,
  normalizePluginExport,
  RESOURCE_OWNED_ROW_IDS,
} from '@agnes/plugin-runtime/host'
import { describe, expect, it, vi } from 'vitest'
import { PublicationGate } from '../src/publication-gate.js'
import { publishedSessionRuntime } from '../src/runtime-generation-view.js'
import { RuntimeMutationGate } from '../src/runtime-mutation-gate.js'
import { RuntimePluginCatalogue } from '../src/runtime-plugin-catalogue.js'
import { buildCompleteRuntimeTarget } from '../src/runtime-target-builder.js'
import { RuntimeTargetPublisher } from '../src/runtime-target-publisher.js'
import { createHostRuntimeTargetResourceFactory } from '../src/runtime-target-resource-bootstrap.js'

const revision = 'a'.repeat(64)

function target(compositeRevision: string, resourceRevision = revision) {
  return buildRuntimeTarget({
    rows: [],
    resourceRevision,
    compositeRevision,
    resources: { mcp: [], skills: {} },
  })
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

describe('RuntimeTargetPublisher', () => {
  it('reports which services a waiting row is missing', async () => {
    const waiting = createPluginRow({
      id: 'host:waits',
      plugin: 'builtin:host/waits',
      snapshotDigest: 'builtin:host:v1',
      exportName: 'default',
      entryRevision: 'entry-1',
      extrasRevision: 'none',
      mountRevision: 'mount-1',
      inject: ['databaseService', 'cacheService'],
    })
    const entry = normalizePluginExport(
      Object.assign(() => {}, { inject: ['databaseService', 'cacheService'] }),
    )
    const publisher = new RuntimeTargetPublisher({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      staticClaims: () => [{ row: waiting, entry }],
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
    })
    await publisher.apply(
      buildRuntimeTarget({
        rows: [waiting],
        resourceRevision: revision,
        compositeRevision: '1'.repeat(64),
        resources: { mcp: [], skills: {} },
      }),
    )
    const row = publisher.current().value.current?.report.rows.find((r) => r.id === 'host:waits')
    expect(row).toEqual({
      id: 'host:waits',
      state: 'pending',
      reason: 'waiting for services: cacheService, databaseService',
    })
    await publisher.close()
  })

  it('fails a delivery whose plugin never finishes starting, and the next delivery still goes through', async () => {
    const stuck = createPluginRow({
      id: 'host:stuck-start',
      plugin: 'builtin:stuck-start',
      snapshotDigest: 'builtin:stuck-start',
      exportName: 'default',
      entryRevision: 'entry-1',
      extrasRevision: 'none',
      mountRevision: 'mount-1',
    })
    let hang = true
    const entry = normalizePluginExport(() => (hang ? new Promise<void>(() => {}) : undefined))
    const publisher = new RuntimeTargetPublisher({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      startTimeoutMs: 50,
      privateInput: () => ({ bootRows: hang ? [stuck] : [] }),
      staticClaims: () => (hang ? [{ row: stuck, entry }] : []),
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
    })
    await expect(publisher.apply(target('1'.repeat(64)))).rejects.toMatchObject({
      detail: { reason: 'row-start-timeout' },
    })
    // Nothing was published, so whatever was live before would still be live.
    expect(publisher.current().value.current).toBeUndefined()

    hang = false
    const two = target('2'.repeat(64))
    await publisher.apply(two)
    expect(publisher.current().value.current?.target).toEqual(two)
    await publisher.close()
  })

  it('constructs an invisible complete candidate and exchanges the sole pointer before retiring old state', async () => {
    const cleanup = vi.fn()
    const publisher = new RuntimeTargetPublisher({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: {
        create(input, scope) {
          scope.defer(() => cleanup(input.target.compositeRevision))
          return { revision: input.target.compositeRevision }
        },
      },
    })
    const one = target('1'.repeat(64))
    const two = target('2'.repeat(64))

    await publisher.apply(one)
    expect(publisher.current().value.current?.target).toEqual(one)
    expect(publisher.current().value.current?.report.rows).toHaveLength(RESOURCE_OWNED_ROW_IDS.length)
    expect(cleanup).not.toHaveBeenCalled()

    await publisher.apply(two)
    expect(publisher.current()).toMatchObject({ epoch: 3, value: { current: { target: two } } })
    await publisher.close()
    expect(cleanup).toHaveBeenCalledWith('1'.repeat(64))
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('keeps the published state when candidate resource health fails', async () => {
    const publisher = new RuntimeTargetPublisher({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: {
        create: (input) => ({ revision: input.target.compositeRevision }),
        health(resources) {
          if (resources.revision.startsWith('f')) throw new Error('resource unhealthy')
        },
      },
    })
    const good = target('3'.repeat(64))
    await publisher.apply(good)
    await expect(publisher.apply(target('f'.repeat(64), 'f'.repeat(64)))).rejects.toThrow(
      'resource unhealthy',
    )
    expect(publisher.current().value.current?.target).toEqual(good)
    await publisher.close()
  })

  it('copy-on-write replaces a session scope without retiring the shared runtime', async () => {
    const resourceCleanup = vi.fn()
    const oldScopeCleanup = vi.fn()
    const newScopeCleanup = vi.fn()
    const publisher = new RuntimeTargetPublisher<{ revision: string }, string>({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: {
        create(input, scope) {
          scope.defer(resourceCleanup)
          return { revision: input.target.compositeRevision }
        },
      },
      rebuildSessionScope: async (_key, desired) => ({
        desired,
        overlay: (desired as { preset: string }).preset,
        close: () => undefined,
      }),
    })
    await publisher.apply(target('4'.repeat(64)))
    await publisher.setSessionScope('session-a', { preset: 'one' }, async () => ({
      desired: { ignored: true },
      overlay: 'one',
      close: oldScopeCleanup,
    }))
    await publisher.apply(
      buildRuntimeTarget({
        rows: [],
        resourceRevision: '5'.repeat(64),
        compositeRevision: '5'.repeat(64),
        resources: { mcp: [], skills: {} },
      }),
    )
    expect(publisher.current().value.current?.target.resource.target.compositeRevision).toBe('5'.repeat(64))
    expect(publisher.current().value.sessionScopes.get('session-a')?.overlay).toBe('one')
    await publisher.setSessionScope('session-a', { preset: 'two' }, async () => ({
      desired: { ignored: true },
      overlay: 'two',
      close: newScopeCleanup,
    }))
    await publisher.current().value.sessionScopes.get('session-a')?.overlay
    await Promise.resolve()
    expect(oldScopeCleanup).toHaveBeenCalledOnce()
    expect(resourceCleanup).toHaveBeenCalledOnce()
    await publisher.closeSessionScope('session-a')
    await Promise.resolve()
    expect(newScopeCleanup).toHaveBeenCalledOnce()
    expect(resourceCleanup).toHaveBeenCalledOnce()
    await publisher.close()
    expect(resourceCleanup).toHaveBeenCalledTimes(2)
  })

  it('keeps an open session scope and runtime identity for registry-neutral target changes', async () => {
    const rebuild = vi.fn()
    const runtime = {} as CurrentSessionRuntime
    const close = vi.fn()
    const publisher = new RuntimeTargetPublisher<{ revision: string }, string>({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
      rebuildSessionScope: async () => {
        rebuild()
        return { desired: { preset: 'new' }, overlay: 'new', runtime, close }
      },
    })
    await publisher.apply(target('a'.repeat(64)))
    await publisher.setSessionScope('session-a', { preset: 'one' }, async () => ({
      desired: { preset: 'one' },
      overlay: 'one',
      runtime,
      close,
    }))
    const before = publisher.current().value.sessionScopes.get('session-a')
    await publisher.apply(target('b'.repeat(64)))
    const after = publisher.current().value.sessionScopes.get('session-a')

    expect(after).toBe(before)
    expect(after?.runtime).toBe(runtime)
    expect(rebuild).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    await publisher.close()
  })

  it('filters web-only rows before ordinary claims and keeps the live tree and scope intact', async () => {
    const runtime = {} as CurrentSessionRuntime
    const web = createPluginRow({
      id: 'web:demo',
      plugin: 'web:demo',
      snapshotDigest: 'web:demo',
      exportName: 'default',
      entryRevision: 'web-row-v1',
      extrasRevision: 'none',
      mountRevision: 'web-row-v1',
    })
    const resourceRow = createPluginRow({
      id: 'ext:agnes/mcp-client',
      plugin: 'builtin:host/mcp-client',
      snapshotDigest: 'resource-row',
      exportName: 'default',
      entryRevision: 'resource-row-v1',
      extrasRevision: 'none',
      mountRevision: 'resource-row-v1',
    })
    const publisher = new RuntimeTargetPublisher<{ revision: string }, string>({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
    })
    await publisher.apply(
      buildRuntimeTarget({
        rows: [resourceRow],
        resourceRevision: revision,
        compositeRevision: 'a'.repeat(64),
        resources: { mcp: [], skills: {} },
      }),
    )
    await publisher.setSessionScope('session-a', { preset: 'one' }, async () => ({
      desired: { preset: 'one' },
      overlay: 'one',
      runtime,
      close: () => undefined,
    }))
    const before = publisher.current().value
    await publisher.apply(
      buildRuntimeTarget({
        rows: [web, resourceRow],
        resourceRevision: revision,
        compositeRevision: 'b'.repeat(64),
        resources: { mcp: [], skills: {} },
      }),
    )
    const after = publisher.current().value
    expect(after.current?.target.tree.rows).toEqual([web])
    expect(after.current?.target.resource.rows['ext:agnes/mcp-client']).toEqual(resourceRow)
    expect(after.current?.ordinary.pluginTree.tree.currentRows()).toEqual([])
    expect(after.current?.ordinary).toBe(before.current?.ordinary)
    expect(after.sessionScopes.get('session-a')).toBe(before.sessionScopes.get('session-a'))
    await publisher.close()
  })

  it('applies an ordinary removal through the live Host transaction and preserves unrelated fibers', async () => {
    const mounted = vi.fn()
    const disposed = vi.fn()
    const row = (id: string) =>
      createPluginRow({
        id,
        plugin: `builtin:${id}/default`,
        snapshotDigest: `publisher-test:${id}`,
        exportName: 'default',
        entryRevision: 'publisher-test-v1',
        extrasRevision: 'none',
        mountRevision: 'publisher-test-v1',
      })
    const initial = row('builtin:publisher-test/first')
    const removed = row('builtin:publisher-test/removed')
    const publisher = new RuntimeTargetPublisher({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
      staticClaims: () => [
        {
          row: initial,
          entry: normalizePluginExport((ctx) => {
            mounted(initial.id)
            ctx.effect(() => () => disposed(initial.id))
          }),
        },
        {
          row: removed,
          entry: normalizePluginExport((ctx) => {
            mounted(removed.id)
            ctx.effect(() => () => disposed(removed.id))
          }),
        },
      ],
    })
    const first = buildRuntimeTarget({
      rows: [initial, removed],
      resourceRevision: revision,
      compositeRevision: '1'.repeat(64),
      resources: { mcp: [], skills: {} },
    })
    await publisher.apply(first)
    const before = publisher.current().value.current?.ordinary.pluginTree.tree.fiber(initial.id)
    await publisher.apply(
      buildRuntimeTarget({
        rows: [initial],
        resourceRevision: revision,
        compositeRevision: '2'.repeat(64),
        resources: { mcp: [], skills: {} },
      }),
    )
    const after = publisher.current().value.current?.ordinary.pluginTree.tree.fiber(initial.id)
    expect(after).toBe(before)
    expect(mounted).toHaveBeenCalledTimes(2)
    expect(disposed).toHaveBeenCalledWith(removed.id)
    expect(publisher.current().value.current?.ordinary.pluginTree.tree.fiber(removed.id)).toBeUndefined()
    await publisher.close()
  })

  it('restores a transaction change when candidate resource activation fails', async () => {
    const mounted = vi.fn()
    const disposed = vi.fn()
    const row = (id: string) =>
      createPluginRow({
        id,
        plugin: `builtin:${id}/default`,
        snapshotDigest: `publisher-test:${id}`,
        exportName: 'default',
        entryRevision: 'publisher-test-v1',
        extrasRevision: 'none',
        mountRevision: 'publisher-test-v1',
      })
    const first = row('builtin:publisher-test/first')
    const removed = row('builtin:publisher-test/removed')
    const publisher = new RuntimeTargetPublisher<{ revision: string }>({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: {
        create: (input) => ({ revision: input.target.compositeRevision }),
        health(resources) {
          if (resources.revision.startsWith('f')) throw new Error('candidate resource failed')
        },
      },
      staticClaims: () => [
        {
          row: first,
          entry: normalizePluginExport((ctx) => {
            mounted(first.id)
            ctx.effect(() => () => disposed(first.id))
          }),
        },
        {
          row: removed,
          entry: normalizePluginExport((ctx) => {
            mounted(removed.id)
            ctx.effect(() => () => disposed(removed.id))
          }),
        },
      ],
    })
    const initial = buildRuntimeTarget({
      rows: [first, removed],
      resourceRevision: revision,
      compositeRevision: '1'.repeat(64),
      resources: { mcp: [], skills: {} },
    })
    await publisher.apply(initial)
    const firstFiber = publisher.current().value.current?.ordinary.pluginTree.tree.fiber(first.id)

    await expect(
      publisher.apply(
        buildRuntimeTarget({
          rows: [first],
          resourceRevision: 'f'.repeat(64),
          compositeRevision: 'f'.repeat(64),
          resources: { mcp: [], skills: {} },
        }),
      ),
    ).rejects.toThrow('candidate resource failed')

    const current = publisher.current().value.current
    expect(current?.target).toEqual(initial)
    expect(current?.ordinary.pluginTree.tree.fiber(first.id)).toBe(firstFiber)
    expect(current?.ordinary.pluginTree.tree.fiber(removed.id)).toBeDefined()
    expect(mounted).toHaveBeenCalledTimes(3)
    expect(disposed).toHaveBeenCalledWith(removed.id)
    await publisher.close()
  })

  it('bounds a hung remount during outer rollback, taints the tree, and does not hang on close', async () => {
    const row = (id: string) =>
      createPluginRow({
        id,
        plugin: `builtin:${id}/default`,
        snapshotDigest: `publisher-test:${id}`,
        exportName: 'default',
        entryRevision: 'publisher-test-v1',
        extrasRevision: 'none',
        mountRevision: 'publisher-test-v1',
      })
    const first = row('builtin:publisher-test/first')
    const removed = row('builtin:publisher-test/removed')
    let removedMountCount = 0
    const publisher = new RuntimeTargetPublisher<{ revision: string }>({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      startTimeoutMs: 30,
      resourceFactory: {
        create: (input) => ({ revision: input.target.compositeRevision }),
        health(resources) {
          if (resources.revision.startsWith('f')) throw new Error('candidate resource failed')
        },
      },
      staticClaims: () => [
        { row: first, entry: normalizePluginExport(() => undefined) },
        {
          row: removed,
          // Mounts normally the first time (initial apply); the SECOND mount — the outer
          // rollback trying to bring it back after the candidate resource check fails — hangs
          // forever, simulating a plugin whose startup never settles.
          entry: normalizePluginExport(() => {
            removedMountCount += 1
            return removedMountCount > 1 ? new Promise<void>(() => {}) : undefined
          }),
        },
      ],
    })
    const initial = buildRuntimeTarget({
      rows: [first, removed],
      resourceRevision: revision,
      compositeRevision: '1'.repeat(64),
      resources: { mcp: [], skills: {} },
    })
    await publisher.apply(initial)
    expect(removedMountCount).toBe(1)

    await expect(
      publisher.apply(
        buildRuntimeTarget({
          rows: [first],
          resourceRevision: 'f'.repeat(64),
          compositeRevision: 'f'.repeat(64),
          resources: { mcp: [], skills: {} },
        }),
      ),
    ).rejects.toThrow('runtime target transaction recovery failed')

    // The hung outer-rollback remount timed out within the configured budget instead of hanging
    // this test (and, in production, the RuntimeMutationGate's writer queue) forever.
    const current = publisher.current().value.current
    expect(current?.ordinary.pluginTree.tainted?.()).toBe(true)

    // Retiring the tainted tree on close must not await the still-hung fiber; close() itself
    // must resolve promptly rather than deadlock behind it.
    await publisher.close()
  })

  it('keeps the prior session scope when its candidate construction fails', async () => {
    const publisher = new RuntimeTargetPublisher<{ revision: string }, string>({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
    })
    await publisher.apply(target('6'.repeat(64)))
    await publisher.setSessionScope('session-a', { preset: 'one' }, async () => ({
      desired: { ignored: true },
      overlay: 'one',
      close: () => undefined,
    }))
    await expect(
      publisher.setSessionScope('session-a', { preset: 'two' }, async () => {
        throw new Error('overlay candidate failed')
      }),
    ).rejects.toThrow('overlay candidate failed')
    expect(publisher.current().value.sessionScopes.get('session-a')?.overlay).toBe('one')
    await publisher.close()
  })

  it('rebuilds a stale scope candidate so concurrent scope opens do not lose either session', async () => {
    const publisher = new RuntimeTargetPublisher<{ revision: string }, string>({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
    })
    await publisher.apply(target('7'.repeat(64)))
    const first = deferred<void>()
    const entered = deferred<void>()
    const aborted = vi.fn()
    let builds = 0
    const openA = publisher.setSessionScope('session-a', { preset: 'a' }, async () => {
      builds += 1
      if (builds === 1) {
        entered.resolve()
        await first.promise
      }
      return { desired: {}, overlay: 'a', close: aborted }
    })
    await entered.promise
    await publisher.setSessionScope('session-b', { preset: 'b' }, async () => ({
      desired: {},
      overlay: 'b',
      close: () => undefined,
    }))
    first.resolve()
    await openA
    expect(builds).toBe(2)
    expect(aborted).toHaveBeenCalledOnce()
    expect([...publisher.current().value.sessionScopes.keys()].sort()).toEqual(['session-a', 'session-b'])
    await publisher.close()
  })

  it('keeps open sessions when apply races setSessionScope and a later ordinary candidate fails', async () => {
    const publisher = new RuntimeTargetPublisher<{ revision: string }, string>({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: {
        create: (input) => ({ revision: input.target.compositeRevision }),
        health(resources) {
          if (resources.revision.startsWith('c')) throw new Error('ordinary candidate failed')
        },
      },
      rebuildSessionScope: async (_key, desired) => ({
        desired,
        overlay: (desired as { preset: string }).preset,
        runtime: {} as CurrentSessionRuntime,
        close: () => undefined,
      }),
    })
    const first = target('a'.repeat(64))
    await publisher.apply(first)
    const hold = deferred<void>()
    const entered = deferred<void>()
    const opening = publisher.setSessionScope('session-a', { preset: 'one' }, async () => {
      entered.resolve()
      await hold.promise
      return { desired: { preset: 'one' }, overlay: 'one', close: () => undefined }
    })
    await entered.promise
    const applying = publisher.apply(target('b'.repeat(64), 'b'.repeat(64)))
    hold.resolve()
    await opening
    await applying
    expect(publisher.current().value.sessionScopes.get('session-a')?.overlay).toBe('one')
    await expect(publisher.apply(target('c'.repeat(64), 'c'.repeat(64)))).rejects.toThrow(
      'ordinary candidate failed',
    )
    expect(publisher.current().value.current?.target.resource.target.compositeRevision).toBe('b'.repeat(64))
    expect(publisher.currentRuntimeLookup().current('session-a')).toBeDefined()
    await publisher.close()
  })

  it('exposes only the published session runtime through the Core lookup adapter', async () => {
    const publisher = new RuntimeTargetPublisher<{ revision: string }, string>({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
    })
    await publisher.apply(target('8'.repeat(64)))
    const runtime = {} as CurrentSessionRuntime
    await publisher.setSessionScope('session-a', { preset: 'one' }, async () => ({
      desired: { preset: 'one' },
      overlay: 'one',
      runtime,
      close: () => undefined,
    }))
    expect(publisher.currentRuntimeLookup().current('session-a')).toBe(runtime)
    expect(() => publisher.currentRuntimeLookup().current('missing')).toThrow('E_RUNTIME_SESSION_UNAVAILABLE')
    await publisher.close()
  })

  it('holds a runtime read lease for the duration of a session operation', async () => {
    const mutation = new RuntimeMutationGate()
    const publisher = new RuntimeTargetPublisher<{ revision: string }, string>({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      mutation,
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
    })
    await publisher.apply(target('8'.repeat(64)))
    const runtime = {} as CurrentSessionRuntime
    await publisher.setSessionScope('session-a', { preset: 'one' }, async () => ({
      desired: { preset: 'one' },
      overlay: 'one',
      runtime,
      close: () => undefined,
    }))
    const mutationStarted = deferred<void>()
    const mutationFinished = deferred<void>()
    const changing = mutation.mutate(async () => {
      mutationStarted.resolve()
      await mutationFinished.promise
    })
    await mutationStarted.promise
    let operationCalled = false
    const operation = publisher.withCurrentRuntime('session-a', async (current) => {
      operationCalled = true
      expect(current).toBe(runtime)
      return 'done'
    })
    await Promise.resolve()
    expect(operationCalled).toBe(false)
    mutationFinished.resolve()
    await changing
    await expect(operation).resolves.toBe('done')
    await publisher.close()
  })

  it('rebuilds open session overlays against a new target without dropping desired presets', async () => {
    const oldA = vi.fn()
    const oldB = vi.fn()
    const publisher = new RuntimeTargetPublisher<{ revision: string }, { preset: string }>({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
      rebuildSessionScope: async (_key, desired) => ({
        desired,
        overlay: { preset: (desired as { preset: string }).preset },
        runtime: {} as CurrentSessionRuntime,
        close: () => undefined,
      }),
    })
    await publisher.apply(target('9'.repeat(64)))
    await publisher.setSessionScope('session-a', { preset: 'one' }, async () => ({
      desired: { preset: 'one' },
      overlay: { preset: 'one' },
      close: oldA,
    }))
    await publisher.setSessionScope('session-b', { preset: 'two' }, async () => ({
      desired: { preset: 'two' },
      overlay: { preset: 'two' },
      close: oldB,
    }))
    const next = target('0'.repeat(64), '0'.repeat(64))
    await publisher.apply(next)
    expect(publisher.current().value.current?.target).toEqual(next)
    expect(publisher.current().value.sessionScopes.get('session-a')?.overlay).toEqual({ preset: 'one' })
    expect(publisher.current().value.sessionScopes.get('session-b')?.overlay).toEqual({ preset: 'two' })
    expect(publisher.currentRuntimeLookup().current('session-a')).toBeDefined()
    expect(publisher.currentRuntimeLookup().current('session-b')).toBeDefined()
    await Promise.resolve()
    expect(oldA).toHaveBeenCalledOnce()
    expect(oldB).toHaveBeenCalledOnce()
    await publisher.close()
  })

  it('rebuilds overlay runtime from the candidate generation, not Kernel shared tables', async () => {
    const kernelTools = new ToolRegistry()
    const cache = new Map()
    const seen: CurrentSessionRuntime[] = []
    const publisher = new RuntimeTargetPublisher<{ revision: string }, { preset: string }>({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
      rebuildSessionScope: async (_key, desired, candidate) => {
        const runtime = publishedSessionRuntime({
          compositeRevision: candidate.target.resource.target.compositeRevision,
          cache,
          hooks: noopHooks,
        })
        expect(runtime.tools).not.toBe(kernelTools)
        seen.push(runtime)
        return {
          desired,
          overlay: { preset: (desired as { preset: string }).preset },
          runtime,
          close: () => undefined,
        }
      },
    })
    const first = target('1'.repeat(64))
    await publisher.apply(first)
    await publisher.setSessionScope('session-a', { preset: 'one' }, async () => ({
      desired: { preset: 'one' },
      overlay: { preset: 'one' },
      close: () => undefined,
    }))
    await publisher.apply(target('2'.repeat(64), '2'.repeat(64)))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.tools).not.toBe(kernelTools)
    expect(publisher.currentRuntimeLookup().current('session-a')?.tools).toBe(seen[0]?.tools)
    expect(publisher.current().value.current?.target.resource.target.compositeRevision).toBe('2'.repeat(64))
    await publisher.close()
  })

  it('lets a child session inherit the parent overlay desired without mixing the sibling preset', async () => {
    const publisher = new RuntimeTargetPublisher<{ revision: string }, { preset: string }>({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
    })
    await publisher.apply(target('e'.repeat(64)))
    await publisher.setSessionScope('session-a', { preset: 'parent' }, async () => ({
      desired: { preset: 'parent' },
      overlay: { preset: 'parent' },
      close: () => undefined,
    }))
    await publisher.setSessionScope('session-b', { preset: 'other' }, async () => ({
      desired: { preset: 'other' },
      overlay: { preset: 'other' },
      close: () => undefined,
    }))
    await publisher.setSessionScope('session-a:child', { preset: 'parent' }, async () => ({
      desired: { preset: 'parent' },
      overlay: { preset: 'parent' },
      close: () => undefined,
    }))
    expect(publisher.current().value.sessionScopes.get('session-a:child')?.overlay).toEqual({
      preset: 'parent',
    })
    expect(publisher.current().value.sessionScopes.get('session-b')?.overlay).toEqual({ preset: 'other' })
    await publisher.close()
  })

  it('keeps the previous target when overlay rebuild fails', async () => {
    const publisher = new RuntimeTargetPublisher<{ revision: string }, { preset: string }>({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
      rebuildSessionScope: async () => {
        throw new Error('overlay rebuild failed')
      },
    })
    const first = target('1'.repeat(64))
    await publisher.apply(first)
    await publisher.setSessionScope('session-a', { preset: 'one' }, async () => ({
      desired: { preset: 'one' },
      overlay: { preset: 'one' },
      close: () => undefined,
    }))
    await expect(publisher.apply(target('2'.repeat(64), '2'.repeat(64)))).rejects.toThrow(
      'overlay rebuild failed',
    )
    expect(publisher.current().value.current?.target).toEqual(first)
    expect(publisher.current().value.sessionScopes.get('session-a')?.overlay).toEqual({ preset: 'one' })
    await publisher.close()
  })

  it('applies builtin static rows from Host-private claims without a third-party snapshot', async () => {
    const builtin = createPluginRow({
      id: 'preset:default',
      plugin: 'builtin:host/preset/default',
      snapshotDigest: 'builtin:host-presets:v1',
      exportName: 'default',
      entryRevision: 'host-preset-row:v1',
      extrasRevision: 'none',
      mountRevision: 'host-preset-row:v1',
    })
    const provide = vi.fn()
    const complete = buildCompleteRuntimeTarget({
      rows: [builtin],
      resources: { mcp: [], skills: {} },
    })
    const publisher = new RuntimeTargetPublisher({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
      staticClaims: () => [{ row: builtin, entry: normalizePluginExport(provide) }],
    })
    await publisher.apply(complete.target)
    expect(provide).toHaveBeenCalledOnce()
    expect(publisher.current().value.current?.target.tree.rows.map((row) => row.id)).toEqual([
      'preset:default',
    ])
    await publisher.close()
  })

  it('refuses a builtin target row when Host-private static claims are missing', async () => {
    const builtin = createPluginRow({
      id: 'preset:default',
      plugin: 'builtin:host/preset/default',
      snapshotDigest: 'builtin:host-presets:v1',
      exportName: 'default',
      entryRevision: 'host-preset-row:v1',
      extrasRevision: 'none',
      mountRevision: 'host-preset-row:v1',
    })
    const publisher = new RuntimeTargetPublisher({
      catalogue: new RuntimePluginCatalogue([]),
      publication: new PublicationGate(),
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: { create: (input) => ({ revision: input.target.compositeRevision }) },
    })
    await expect(
      publisher.apply(
        buildCompleteRuntimeTarget({ rows: [builtin], resources: { mcp: [], skills: {} } }).target,
      ),
    ).rejects.toThrow('E_RUNTIME_TARGET_STATIC_CLAIM')
    await publisher.close()
  })

  it('applies one complete target with ordinary, static and all resource-owned rows on the shared gate', async () => {
    const gate = new PublicationGate()
    const claims = ['preset:default', 'seam:approval', 'ext:demo'].map((id) => {
      const row = createPluginRow({
        id,
        plugin: `builtin:host/${id}`,
        snapshotDigest: 'builtin:host:v1',
        exportName: id,
        entryRevision: 'host-row:v1',
        extrasRevision: 'none',
        mountRevision: 'host-row:v1',
      })
      return Object.freeze({ row, entry: normalizePluginExport(() => undefined) })
    })
    const resourceRows = RESOURCE_OWNED_ROW_IDS.map((id) =>
      createPluginRow({
        id,
        plugin: `builtin:host/${id}`,
        snapshotDigest: 'builtin:host:v1',
        exportName: id,
        entryRevision: 'host-row:v1',
        extrasRevision: 'none',
        mountRevision: 'host-row:v1',
      }),
    )
    const complete = buildCompleteRuntimeTarget({
      rows: [...claims.map((claim) => claim.row), ...resourceRows],
      resources: { mcp: [{ id: 'mcp-a' }], skills: { a: { name: 'a' } } },
    })
    const publisher = new RuntimeTargetPublisher({
      catalogue: new RuntimePluginCatalogue([]),
      publication: gate,
      load: async () => undefined,
      trust: () => undefined,
      resourceFactory: createHostRuntimeTargetResourceFactory({
        mcp: { list: () => [{ config: { id: 'live' } } as never] },
      }),
      staticClaims: () => claims,
    })
    const published = await publisher.apply(complete.target)
    const current = published.value.current
    expect(current?.target).toEqual(complete.target)
    expect(current?.target.tree.rows.map((row) => row.id)).toEqual([
      'ext:demo',
      'preset:default',
      'seam:approval',
    ])
    for (const id of RESOURCE_OWNED_ROW_IDS) expect(current?.target.resource.rows[id]?.id).toBe(id)
    expect(
      current?.report.rows.filter((row) => (RESOURCE_OWNED_ROW_IDS as readonly string[]).includes(row.id)),
    ).toHaveLength(RESOURCE_OWNED_ROW_IDS.length)
    expect(current?.resources).toBeDefined()
    await publisher.close()
  })
})
