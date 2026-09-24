import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  McpLifecycleAdapter,
  ResourceControlStore,
  SkillCatalogAdapter,
} from '@agnes/resource-control-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResourceAdapterOptions } from '../src/service-adapters.js'
import { installResourceServiceAdapters } from '../src/service-adapters.js'

type FakePool = ResourceAdapterOptions['pool']

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const REVISION = 'f'.repeat(64)

function fakeMcpStatus(serverId: string, connectionState: 'ready' | 'connecting' | 'unavailable' = 'ready') {
  return {
    serverId,
    connectionState,
    observedRevision: connectionState === 'ready' ? REVISION : null,
    catalogRevision: null,
    toolCount: 0,
    observedAt: new Date(0).toISOString(),
    ...(connectionState === 'unavailable'
      ? { lastSafeError: { code: 'MCP_UNTRUSTED_REVISION', message: 'trust is untrusted' } }
      : {}),
  }
}

function snapshotFile(): { home: string; snapshotPath: string } {
  const home = mkdtempSync(join(tmpdir(), 'agnes-resource-control-daemon-'))
  dirs.push(home)
  const snapshotPath = join(home, 'snapshot.json')
  writeFileSync(snapshotPath, '{"skills":[],"mcp":[]}', 'utf8')
  return { home, snapshotPath }
}

/** A minimal `ResourceControlStore` double: only what these adapters actually call. Every test that
 *  never exercises a Skill operation can pass an arbitrary path - `service()`'s snapshot read
 *  (MCP no longer uses it, only Skills still do) simply never runs for those. */
function fakeStoreWith(
  options: {
    snapshotPath?: string
    observeWorker?: (profile: string, statuses: readonly unknown[]) => void
    observedStatus?: (profile: string, serverId: string) => unknown
  } = {},
): {
  store: ResourceControlStore
  capturedAdapters(): { skills: SkillCatalogAdapter; mcp: McpLifecycleAdapter }
} {
  let captured: { skills: SkillCatalogAdapter; mcp: McpLifecycleAdapter } | undefined
  const store = {
    snapshotPath: () => options.snapshotPath ?? snapshotFile().snapshotPath,
    setAdapters: (adapters: { skills: SkillCatalogAdapter; mcp: McpLifecycleAdapter }) => {
      captured = adapters
    },
    mcp: {
      observeWorker: async (profile: string, statuses: readonly unknown[]) => {
        options.observeWorker?.(profile, statuses)
      },
      observedStatus: async (profile: string, serverId: string) =>
        options.observedStatus?.(profile, serverId),
    },
  } as unknown as ResourceControlStore
  return {
    store,
    capturedAdapters: () => {
      if (!captured) throw new Error('setAdapters was never called')
      return captured
    },
  }
}

describe('installResourceServiceAdapters — MCP over the shared session worker', () => {
  it('MCP reconcile needs no workspace root at all, unlike a Skill operation', async () => {
    const { snapshotPath } = snapshotFile()
    const { store, capturedAdapters } = fakeStoreWith({ snapshotPath })
    const acquire = vi.fn()
    const acquireSharedWorker = vi.fn(async () => ({
      hello: Promise.resolve({}),
      command: async () => fakeMcpStatus('srv'),
      close: () => undefined,
      alive: true,
    }))
    installResourceServiceAdapters({
      store,
      pool: { acquire, acquireSharedWorker } as unknown as FakePool,
      profile: { name: 'local-dev', hash: 'c'.repeat(64) },
      // No workspaceRoot: a Skill operation (still workspace-bound) fails closed; MCP does not.
      refreshPackageSkills: async () => undefined,
    })
    const adapters = capturedAdapters()

    await expect(
      adapters.skills.refresh({ profile: 'local-dev', signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'E_WORKSPACE_REQUIRED' })
    expect(acquire).not.toHaveBeenCalled()

    const result = await adapters.mcp.reconcile({
      profile: 'local-dev',
      serverId: 'srv',
      definition: {} as Parameters<McpLifecycleAdapter['reconcile']>[0]['definition'],
      enabled: true,
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ status: fakeMcpStatus('srv') })
    expect(acquireSharedWorker).toHaveBeenCalledOnce()
  })

  it('reconcile sends resourceMcpApply (never resourceMcpReconnect) and returns whatever status the worker settled on', async () => {
    const { store, capturedAdapters } = fakeStoreWith()
    const calls: Array<{ method: string; params: unknown }> = []
    const acquireSharedWorker = vi.fn(async () => ({
      hello: Promise.resolve({}),
      command: async (method: string, params: unknown) => {
        calls.push({ method, params })
        return fakeMcpStatus('srv')
      },
      close: () => undefined,
      alive: true,
    }))
    installResourceServiceAdapters({
      store,
      pool: { acquire: vi.fn(), acquireSharedWorker } as unknown as FakePool,
      profile: { name: 'local-dev', hash: 'a'.repeat(64) },
      refreshPackageSkills: async () => undefined,
    })
    const adapters = capturedAdapters()

    await adapters.mcp.reconcile({
      profile: 'local-dev',
      serverId: 'srv',
      definition: {} as Parameters<McpLifecycleAdapter['reconcile']>[0]['definition'],
      enabled: true,
      signal: new AbortController().signal,
    })

    expect(calls).toEqual([{ method: 'resourceMcpApply', params: { serverId: 'srv' } }])
  })

  it('reconcile with enabled:true surfaces the worker’s own error when not ready, and none when enabled:false', async () => {
    const { store, capturedAdapters } = fakeStoreWith()
    const acquireSharedWorker = vi.fn(async () => ({
      hello: Promise.resolve({}),
      command: async () => fakeMcpStatus('srv', 'unavailable'),
      close: () => undefined,
      alive: true,
    }))
    installResourceServiceAdapters({
      store,
      pool: { acquire: vi.fn(), acquireSharedWorker } as unknown as FakePool,
      profile: { name: 'local-dev', hash: 'a'.repeat(64) },
      refreshPackageSkills: async () => undefined,
    })
    const adapters = capturedAdapters()
    const definition = {} as Parameters<McpLifecycleAdapter['reconcile']>[0]['definition']

    const failed = await adapters.mcp.reconcile({
      profile: 'local-dev',
      serverId: 'srv',
      definition,
      enabled: true,
      signal: new AbortController().signal,
    })
    expect(failed.error).toEqual({ code: 'MCP_UNTRUSTED_REVISION', message: 'trust is untrusted' })

    const disabled = await adapters.mcp.reconcile({
      profile: 'local-dev',
      serverId: 'srv',
      definition,
      enabled: false,
      signal: new AbortController().signal,
    })
    expect(disabled.error).toBeUndefined()
  })

  it('reconcile falls back to a generic error when the worker reports no-longer-ready with no reason', async () => {
    const { store, capturedAdapters } = fakeStoreWith()
    const acquireSharedWorker = vi.fn(async () => ({
      hello: Promise.resolve({}),
      command: async () => fakeMcpStatus('srv', 'connecting'),
      close: () => undefined,
      alive: true,
    }))
    installResourceServiceAdapters({
      store,
      pool: { acquire: vi.fn(), acquireSharedWorker } as unknown as FakePool,
      profile: { name: 'local-dev', hash: 'a'.repeat(64) },
      refreshPackageSkills: async () => undefined,
    })
    const adapters = capturedAdapters()

    const result = await adapters.mcp.reconcile({
      profile: 'local-dev',
      serverId: 'srv',
      definition: {} as Parameters<McpLifecycleAdapter['reconcile']>[0]['definition'],
      enabled: true,
      signal: new AbortController().signal,
    })
    expect(result.error).toEqual({
      code: 'MCP_CANDIDATE_UNAVAILABLE',
      message: 'candidate worker did not report a ready MCP connection',
    })
  })

  it('reconnect sends resourceMcpReconnect and always errors when the result is not ready, regardless of desired state', async () => {
    const { store, capturedAdapters } = fakeStoreWith()
    const calls: Array<{ method: string; params: unknown }> = []
    const acquireSharedWorker = vi.fn(async () => ({
      hello: Promise.resolve({}),
      command: async (method: string, params: unknown) => {
        calls.push({ method, params })
        return fakeMcpStatus('srv', 'unavailable')
      },
      close: () => undefined,
      alive: true,
    }))
    installResourceServiceAdapters({
      store,
      pool: { acquire: vi.fn(), acquireSharedWorker } as unknown as FakePool,
      profile: { name: 'local-dev', hash: 'a'.repeat(64) },
      refreshPackageSkills: async () => undefined,
    })
    const adapters = capturedAdapters()

    const result = await adapters.mcp.reconnect({
      profile: 'local-dev',
      serverId: 'srv',
      definition: {} as Parameters<McpLifecycleAdapter['reconnect']>[0]['definition'],
      signal: new AbortController().signal,
    })

    expect(calls).toEqual([{ method: 'resourceMcpReconnect', params: { serverId: 'srv' } }])
    expect(result.error).toEqual({ code: 'MCP_UNTRUSTED_REVISION', message: 'trust is untrusted' })
  })

  it('tools reads the journal’s own observedRevision and pages the shared worker’s catalog for exactly that revision', async () => {
    const observedStatus = vi.fn(async () => fakeMcpStatus('srv', 'ready'))
    const { store, capturedAdapters } = fakeStoreWith({ observedStatus })
    const calls: Array<{ method: string; params: unknown }> = []
    const page = { serverId: 'srv', catalogRevision: 'c'.repeat(64), items: [] }
    const acquireSharedWorker = vi.fn(async () => ({
      hello: Promise.resolve({}),
      command: async (method: string, params: unknown) => {
        calls.push({ method, params })
        return page
      },
      close: () => undefined,
      alive: true,
    }))
    installResourceServiceAdapters({
      store,
      pool: { acquire: vi.fn(), acquireSharedWorker } as unknown as FakePool,
      profile: { name: 'local-dev', hash: 'a'.repeat(64) },
      refreshPackageSkills: async () => undefined,
    })
    const adapters = capturedAdapters()

    const result = await adapters.mcp.tools({
      profile: 'local-dev',
      serverId: 'srv',
      cursor: '100',
      signal: new AbortController().signal,
    })

    expect(observedStatus).toHaveBeenCalledWith('local-dev', 'srv')
    expect(calls).toEqual([
      { method: 'resourceMcpTools', params: { serverId: 'srv', expectedRevision: REVISION, cursor: '100' } },
    ])
    expect(result).toEqual(page)
  })

  it('tools refuses when the journal has no ready observation for this server, without ever asking the worker', async () => {
    for (const observedStatus of [
      async () => undefined,
      async () => fakeMcpStatus('srv', 'connecting'),
      async () => fakeMcpStatus('srv', 'unavailable'),
    ]) {
      const { store, capturedAdapters } = fakeStoreWith({ observedStatus })
      const acquireSharedWorker = vi.fn()
      installResourceServiceAdapters({
        store,
        pool: { acquire: vi.fn(), acquireSharedWorker } as unknown as FakePool,
        profile: { name: 'local-dev', hash: 'a'.repeat(64) },
        refreshPackageSkills: async () => undefined,
      })
      const adapters = capturedAdapters()

      await expect(
        adapters.mcp.tools({
          profile: 'local-dev',
          serverId: 'srv',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('resource MCP catalog has no ready active generation')
      expect(acquireSharedWorker).not.toHaveBeenCalled()
    }
  })

  it('observeMcpStatus only accepts a report whose sessionKey is the shared worker, and only a valid McpStatus', async () => {
    const observed: unknown[] = []
    const { store } = fakeStoreWith({ observeWorker: (_profile, statuses) => observed.push(...statuses) })
    const { observeMcpStatus } = installResourceServiceAdapters({
      store,
      pool: { acquire: vi.fn(), acquireSharedWorker: vi.fn() } as unknown as FakePool,
      profile: { name: 'local-dev', hash: 'a'.repeat(64) },
      refreshPackageSkills: async () => undefined,
    })

    observeMcpStatus({ sessionKey: 'not-shared', serverId: 'srv', status: fakeMcpStatus('srv') })
    expect(observed).toEqual([])

    observeMcpStatus({
      sessionKey: '@shared',
      serverId: 'srv',
      status: { not: 'a valid McpStatus' } as never,
    })
    expect(observed).toEqual([])

    observeMcpStatus({ sessionKey: '@shared', serverId: 'srv', status: fakeMcpStatus('srv') })
    expect(observed).toEqual([fakeMcpStatus('srv')])
  })
})

/** A schema-valid `SkillDescriptor` fixture, overridable per test. */
function fakeSkillDescriptor(
  resourceId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: 'skill',
    resourceId,
    name: 'fixture',
    description: 'fixture skill',
    revision: 'e'.repeat(64),
    sourceIdentity: { scope: 'package', rootKey: 'package', sourceId: 'd'.repeat(64) },
    priority: 50,
    resolution: { winner: true, shadowed: [] },
    trust: 'trusted',
    desired: 'enabled',
    actual: 'ready',
    stale: false,
    ...overrides,
  }
}

function fakeSkillScanReply(input: {
  skills?: unknown[]
  candidates?: unknown[]
  failedRoots?: string[]
  skippedResourceIds?: string[]
  roots?: unknown[]
}) {
  return {
    skills: input.skills ?? [],
    candidates: input.candidates ?? [],
    failedRoots: input.failedRoots ?? [],
    skippedResourceIds: input.skippedResourceIds ?? [],
    roots: input.roots ?? [],
  }
}

describe('installResourceServiceAdapters — Skill scan/removal over the shared session worker', () => {
  it('refresh sends resourceSkillScan with the resolved workspace root, rootKey and current snapshot revision', async () => {
    const { snapshotPath } = snapshotFile()
    const revisionHash = createHash('sha256').update('{"skills":[],"mcp":[]}', 'utf8').digest('hex')
    const { store, capturedAdapters } = fakeStoreWith({ snapshotPath })
    const calls: Array<{ method: string; params: unknown }> = []
    const candidate = {
      descriptor: fakeSkillDescriptor('skill/package/fixture'),
      capabilityHash: 'a'.repeat(64),
    }
    const acquireSharedWorker = vi.fn(async () => ({
      hello: Promise.resolve({}),
      command: async (method: string, params: unknown) => {
        calls.push({ method, params })
        return fakeSkillScanReply({ candidates: [candidate] })
      },
      close: () => undefined,
      alive: true,
    }))
    installResourceServiceAdapters({
      store,
      pool: { acquire: vi.fn(), acquireSharedWorker } as unknown as FakePool,
      profile: { name: 'local-dev', hash: 'a'.repeat(64) },
      workspaceRoot: '/ws/default',
      refreshPackageSkills: async () => undefined,
    })
    const adapters = capturedAdapters()

    const result = await adapters.skills.refresh({
      profile: 'local-dev',
      rootKey: 'package',
      signal: new AbortController().signal,
    })

    expect(calls).toEqual([
      {
        method: 'resourceSkillScan',
        params: { workspaceRoot: '/ws/default', rootKey: 'package', snapshotRevision: revisionHash },
      },
    ])
    expect(result).toEqual({ candidates: [candidate], failedRoots: [] })
  })

  it('refresh omits rootKey from the command params when none is given', async () => {
    const { store, capturedAdapters } = fakeStoreWith()
    const calls: Array<{ method: string; params: unknown }> = []
    const acquireSharedWorker = vi.fn(async () => ({
      hello: Promise.resolve({}),
      command: async (method: string, params: unknown) => {
        calls.push({ method, params })
        return fakeSkillScanReply({})
      },
      close: () => undefined,
      alive: true,
    }))
    installResourceServiceAdapters({
      store,
      pool: { acquire: vi.fn(), acquireSharedWorker } as unknown as FakePool,
      profile: { name: 'local-dev', hash: 'a'.repeat(64) },
      workspaceRoot: '/ws/default',
      refreshPackageSkills: async () => undefined,
    })
    const adapters = capturedAdapters()

    await adapters.skills.refresh({ profile: 'local-dev', signal: new AbortController().signal })

    const params = calls[0]?.params as Record<string, unknown> | undefined
    expect(params && 'rootKey' in params).toBe(false)
  })

  it('removeSkill resolves the workspace from the descriptor and sends resourceSkillRemove, without acquiring or closing a candidate worker', async () => {
    const { store, capturedAdapters } = fakeStoreWith()
    const calls: Array<{ method: string; params: unknown }> = []
    const close = vi.fn()
    const acquire = vi.fn()
    const acquireSharedWorker = vi.fn(async () => ({
      hello: Promise.resolve({}),
      command: async (method: string, params: unknown) => {
        calls.push({ method, params })
        return { ok: true }
      },
      close,
      alive: true,
    }))
    const resolveWorkspace = vi.fn(async (workspaceId?: string) => ({
      workspaceId: workspaceId ?? '',
      path: `/ws/${workspaceId}`,
    }))
    installResourceServiceAdapters({
      store,
      pool: { acquire, acquireSharedWorker } as unknown as FakePool,
      profile: { name: 'local-dev', hash: 'a'.repeat(64) },
      resolveWorkspace,
      refreshPackageSkills: async () => undefined,
    })
    const adapters = capturedAdapters()
    const descriptor = fakeSkillDescriptor('skill/workspace/fixture', {
      sourceIdentity: { scope: 'workspace', rootKey: 'workspace-agnes', sourceId: 'd'.repeat(64) },
      workspaceId: 'f'.repeat(64),
    })

    await adapters.skills.remove?.({
      profile: 'local-dev',
      descriptor: descriptor as never,
      signal: new AbortController().signal,
    })

    expect(resolveWorkspace).toHaveBeenCalledWith('f'.repeat(64))
    expect(calls).toEqual([
      {
        method: 'resourceSkillRemove',
        params: { workspaceRoot: `/ws/${'f'.repeat(64)}`, descriptor, validateOnly: false },
      },
    ])
    expect(acquire).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('reconcile scans once per distinct workspace referenced by the given resources, merging observations from every scan', async () => {
    const { store, capturedAdapters } = fakeStoreWith()
    const workspaceA = 'a'.repeat(64)
    const workspaceB = 'b'.repeat(64)
    const scannedRoots: string[] = []
    const acquireSharedWorker = vi.fn(async () => ({
      hello: Promise.resolve({}),
      command: async (_method: string, params: unknown) => {
        const workspaceRoot = (params as { workspaceRoot: string }).workspaceRoot
        scannedRoots.push(workspaceRoot)
        const skills =
          workspaceRoot === `/ws/${workspaceA}`
            ? [fakeSkillDescriptor('skill/workspace/one', { workspaceId: workspaceA })]
            : [fakeSkillDescriptor('skill/workspace/two', { workspaceId: workspaceB })]
        return fakeSkillScanReply({ skills })
      },
      close: () => undefined,
      alive: true,
    }))
    const resolveWorkspace = vi.fn(async (workspaceId?: string) => ({
      workspaceId: workspaceId ?? '',
      path: `/ws/${workspaceId}`,
    }))
    installResourceServiceAdapters({
      store,
      pool: { acquire: vi.fn(), acquireSharedWorker } as unknown as FakePool,
      profile: { name: 'local-dev', hash: 'a'.repeat(64) },
      resolveWorkspace,
      refreshPackageSkills: async () => undefined,
    })
    const adapters = capturedAdapters()

    const resources = [
      {
        kind: 'skill',
        resourceId: 'skill/workspace/one',
        sourceIdentity: { rootKey: 'workspace-agnes' },
        workspaceId: workspaceA,
      },
      {
        kind: 'skill',
        resourceId: 'skill/workspace/two',
        sourceIdentity: { rootKey: 'workspace-agnes' },
        workspaceId: workspaceB,
      },
    ] as unknown as Parameters<SkillCatalogAdapter['reconcile']>[0]['resources']

    const observations = await adapters.skills.reconcile({
      profile: 'local-dev',
      resources,
      signal: new AbortController().signal,
    })

    expect(new Set(scannedRoots)).toEqual(new Set([`/ws/${workspaceA}`, `/ws/${workspaceB}`]))
    expect(observations.map((row) => row.resourceId).sort()).toEqual(
      ['skill/workspace/one', 'skill/workspace/two'].sort(),
    )
  })

  it('reconcile fails when a requested Skill was not observed by any scan', async () => {
    const { store, capturedAdapters } = fakeStoreWith()
    const acquireSharedWorker = vi.fn(async () => ({
      hello: Promise.resolve({}),
      command: async () => fakeSkillScanReply({}),
      close: () => undefined,
      alive: true,
    }))
    installResourceServiceAdapters({
      store,
      pool: { acquire: vi.fn(), acquireSharedWorker } as unknown as FakePool,
      profile: { name: 'local-dev', hash: 'a'.repeat(64) },
      workspaceRoot: '/ws/default',
      refreshPackageSkills: async () => undefined,
    })
    const adapters = capturedAdapters()
    const resources = [
      { kind: 'skill', resourceId: 'skill/package/missing', sourceIdentity: { rootKey: 'package' } },
    ] as unknown as Parameters<SkillCatalogAdapter['reconcile']>[0]['resources']

    await expect(
      adapters.skills.reconcile({ profile: 'local-dev', resources, signal: new AbortController().signal }),
    ).rejects.toThrow('resource worker did not observe every requested skill')
  })

  it('refresh and reconcile propagate the worker rejecting a stale snapshot revision as a hard failure', async () => {
    const { store, capturedAdapters } = fakeStoreWith()
    const acquireSharedWorker = vi.fn(async () => ({
      hello: Promise.resolve({}),
      command: async () => {
        throw new Error('resource snapshot changed before this Skill scan completed')
      },
      close: () => undefined,
      alive: true,
    }))
    installResourceServiceAdapters({
      store,
      pool: { acquire: vi.fn(), acquireSharedWorker } as unknown as FakePool,
      profile: { name: 'local-dev', hash: 'a'.repeat(64) },
      workspaceRoot: '/ws/default',
      refreshPackageSkills: async () => undefined,
    })
    const adapters = capturedAdapters()

    await expect(
      adapters.skills.refresh({ profile: 'local-dev', signal: new AbortController().signal }),
    ).rejects.toThrow('resource snapshot changed before this Skill scan completed')
  })

  it('refresh rejects a malformed scan reply instead of returning it', async () => {
    const { store, capturedAdapters } = fakeStoreWith()
    const acquireSharedWorker = vi.fn(async () => ({
      hello: Promise.resolve({}),
      command: async () => ({ skills: [], candidates: 'not-an-array', failedRoots: [] }),
      close: () => undefined,
      alive: true,
    }))
    installResourceServiceAdapters({
      store,
      pool: { acquire: vi.fn(), acquireSharedWorker } as unknown as FakePool,
      profile: { name: 'local-dev', hash: 'a'.repeat(64) },
      workspaceRoot: '/ws/default',
      refreshPackageSkills: async () => undefined,
    })
    const adapters = capturedAdapters()

    await expect(
      adapters.skills.refresh({ profile: 'local-dev', signal: new AbortController().signal }),
    ).rejects.toThrow('invalid private skill scan reply')
  })
})
