import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jcs } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createResourceControlService,
  createResourceControlStore,
  McpResourceStore,
  RESOURCE_ALL_PERMISSIONS,
  type ResourceAuthority,
} from '../src/index.js'

const profile = 'local-dev'
const scope = { allowedProfiles: [profile] }
const authority: ResourceAuthority = {
  audience: 'admin',
  principalId: 'owner',
  clientId: 'client',
  permissions: RESOURCE_ALL_PERMISSIONS,
}
const definition = {
  serverId: 'example',
  displayName: 'Example',
  transport: { kind: 'stdio' as const, executable: 'example-mcp', args: [] },
  secretBinding: { kind: 'none' as const },
}
const revision = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
type TestResult = Readonly<{
  operationId: string
  state: string
  items: readonly Readonly<{ resourceId: string; revision: string }>[]
}>
type TestService = Omit<ReturnType<typeof createResourceControlService>, 'call'> & {
  call(...args: Parameters<ReturnType<typeof createResourceControlService>['call']>): Promise<TestResult>
}
const testService = (service: ReturnType<typeof createResourceControlService>): TestService =>
  service as TestService
let directory = ''
const ready = (serverId: string) => ({
  serverId,
  connectionState: 'ready' as const,
  observedRevision: revision(definition),
  catalogRevision: 'a'.repeat(64),
  toolCount: 1,
  observedAt: new Date().toISOString(),
})
async function settled(service: TestService, operationId: string) {
  for (let i = 0; i < 100; i++) {
    const op = await service.call('_agnes/v1/resources.operation.get', { profile, operationId }, authority)
    if (['succeeded', 'failed', 'cancelled'].includes(op.state)) return op
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('operation did not settle')
}
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ''
})

describe('MCP durable resource control', () => {
  it('adopts one command once, rejects conflicting replay and blocks removal while enabled', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-control-'))
    const store = new McpResourceStore(directory, scope, {
      reconcile: async ({ serverId, enabled, definition: candidate }) => {
        if (candidate.displayName === 'Bad candidate') throw new Error('candidate could not connect')
        return {
          status: enabled ? ready(serverId) : { ...ready(serverId), connectionState: 'disabled' as const },
        }
      },
      reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
      test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
      tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
    })
    const service = testService(createResourceControlService(store))
    const create = await service.call(
      '_agnes/v1/mcp.servers.create',
      { profile, definition, clientId: 'client', commandId: 'create-1' },
      authority,
    )
    expect(await settled(service, create.operationId)).toMatchObject({ state: 'succeeded' })
    await expect(
      service.call(
        '_agnes/v1/mcp.servers.create',
        { profile, definition, clientId: 'client', commandId: 'create-1' },
        authority,
      ),
    ).resolves.toEqual(create)
    await expect(
      service.call(
        '_agnes/v1/mcp.servers.create',
        {
          profile,
          definition: { ...definition, displayName: 'different' },
          clientId: 'client',
          commandId: 'create-1',
        },
        authority,
      ),
    ).rejects.toMatchObject({ data: { code: 'COMMAND_CONFLICT' } })
    const trust = await service.call(
      '_agnes/v1/mcp.servers.trust.set',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        trust: 'trusted',
        clientId: 'client',
        commandId: 'trust-1',
      },
      authority,
    )
    await settled(service, trust.operationId)
    const enable = await service.call(
      '_agnes/v1/mcp.servers.enable',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'enable-1',
      },
      authority,
    )
    await settled(service, enable.operationId)
    await expect(
      service.call(
        '_agnes/v1/mcp.servers.remove',
        {
          profile,
          serverId: definition.serverId,
          expectedRevision: revision(definition),
          clientId: 'client',
          commandId: 'remove-1',
        },
        authority,
      ),
    ).rejects.toMatchObject({ data: { code: 'RESOURCE_REMOVE_BLOCKED' } })
    const badDefinition = { ...definition, displayName: 'Bad candidate' }
    const update = await service.call(
      '_agnes/v1/mcp.servers.update',
      {
        profile,
        serverId: definition.serverId,
        definition: badDefinition,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'update-bad',
      },
      authority,
    )
    expect(await settled(service, update.operationId)).toMatchObject({ state: 'failed' })
    // The failed candidate never destroys the last ready definition/status used by reconnect/tools.
    await expect(
      service.call('_agnes/v1/mcp.servers.get', { profile, serverId: definition.serverId }, authority),
    ).resolves.toMatchObject({ revision: revision(definition), actual: 'ready' })
  })

  it('does not delegate a catalog read after the definition has been removed', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-remove-catalog-'))
    const tools = vi.fn(async ({ serverId }: { serverId: string }) => ({
      serverId,
      catalogRevision: 'a'.repeat(64),
      items: [],
    }))
    const store = new McpResourceStore(directory, scope, {
      reconcile: async ({ serverId, enabled }) => ({
        status: enabled ? ready(serverId) : { ...ready(serverId), connectionState: 'disabled' as const },
      }),
      reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
      test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
      tools,
      unstage: async () => undefined,
    })
    const service = testService(createResourceControlService(store))
    const create = await service.call(
      '_agnes/v1/mcp.servers.create',
      { profile, definition, clientId: 'client', commandId: 'create-catalog' },
      authority,
    )
    await settled(service, create.operationId)
    const trust = await service.call(
      '_agnes/v1/mcp.servers.trust.set',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        trust: 'trusted',
        clientId: 'client',
        commandId: 'trust-catalog',
      },
      authority,
    )
    await settled(service, trust.operationId)
    const enable = await service.call(
      '_agnes/v1/mcp.servers.enable',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'enable-catalog',
      },
      authority,
    )
    await settled(service, enable.operationId)
    await expect(
      service.call('_agnes/v1/mcp.servers.tools.list', { profile, serverId: definition.serverId }, authority),
    ).resolves.toEqual({ serverId: definition.serverId, catalogRevision: 'a'.repeat(64), items: [] })
    expect(tools).toHaveBeenCalledTimes(1)
    const disable = await service.call(
      '_agnes/v1/mcp.servers.disable',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'disable-catalog',
      },
      authority,
    )
    await settled(service, disable.operationId)
    const remove = await service.call(
      '_agnes/v1/mcp.servers.remove',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'remove-catalog',
      },
      authority,
    )
    await settled(service, remove.operationId)
    await expect(
      service.call('_agnes/v1/mcp.servers.tools.list', { profile, serverId: definition.serverId }, authority),
    ).rejects.toMatchObject({ data: { code: 'MCP_NOT_FOUND' } })
    expect(tools).toHaveBeenCalledTimes(1)
  })

  it('re-drives received and interrupted MCP operations after restart without trusting a departed observation', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-recover-'))
    const initial = new McpResourceStore(directory, scope, {
      reconcile: async ({ serverId, enabled }) => ({
        status: enabled ? ready(serverId) : { ...ready(serverId), connectionState: 'disabled' as const },
      }),
      reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
      test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
      tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
    })
    initial.setDeferredDrive(true)
    const initialService = testService(createResourceControlService(initial))
    const received = await initialService.call(
      '_agnes/v1/mcp.servers.create',
      {
        profile,
        definition: { ...definition, serverId: 'received' },
        clientId: 'client',
        commandId: 'recover-received',
      },
      authority,
    )
    const created = await initialService.call(
      '_agnes/v1/mcp.servers.create',
      { profile, definition, clientId: 'client', commandId: 'recover-running' },
      authority,
    )
    const journalPath = join(directory, `${profile}.mcp.json`)
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      operations: Array<{ operation: { operationId: string; state: string; progress?: number } }>
    }
    const interrupted = journal.operations.find(
      (entry) => entry.operation.operationId === created.operationId,
    )
    if (!interrupted) throw new Error('received operation was not persisted')
    interrupted.operation = { ...interrupted.operation, state: 'running', progress: 50 }
    await writeFile(journalPath, JSON.stringify(journal))

    const reconcile = vi.fn(async ({ serverId, enabled }: { serverId: string; enabled: boolean }) => ({
      status: enabled ? ready(serverId) : { ...ready(serverId), connectionState: 'disabled' as const },
    }))
    const restarted = new McpResourceStore(directory, scope, {
      reconcile,
      reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
      test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
      tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
    })
    await restarted.recover()
    const restoredService = testService(createResourceControlService(restarted))
    await expect(
      restoredService.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: received.operationId },
        authority,
      ),
    ).resolves.toMatchObject({ state: 'succeeded' })
    await expect(
      restoredService.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: created.operationId },
        authority,
      ),
    ).resolves.toMatchObject({ state: 'succeeded' })
    await expect(
      restoredService.call(
        '_agnes/v1/mcp.servers.get',
        { profile, serverId: definition.serverId },
        authority,
      ),
    ).resolves.toMatchObject({ actual: 'disabled' })
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ profile, serverId: definition.serverId, enabled: false }),
    )
  })

  it('rewrites the worker snapshot after removal and retains the terminal operation', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-remove-snapshot-'))
    const store = createResourceControlStore({
      directory,
      scope,
      skills: {
        refresh: async () => [],
        reconcile: async () => [],
      },
      mcp: {
        reconcile: async ({ serverId, enabled }) => ({
          status: enabled ? ready(serverId) : { ...ready(serverId), connectionState: 'disabled' as const },
        }),
        reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
        test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
        tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
        unstage: async () => undefined,
      },
    })
    const service = testService(createResourceControlService(store))
    const create = await service.call(
      '_agnes/v1/mcp.servers.create',
      { profile, definition, clientId: 'client', commandId: 'create-snapshot' },
      authority,
    )
    await settled(service, create.operationId)
    const trust = await service.call(
      '_agnes/v1/mcp.servers.trust.set',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        trust: 'trusted',
        clientId: 'client',
        commandId: 'trust-snapshot',
      },
      authority,
    )
    await settled(service, trust.operationId)
    const enable = await service.call(
      '_agnes/v1/mcp.servers.enable',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'enable-snapshot',
      },
      authority,
    )
    await settled(service, enable.operationId)
    const disable = await service.call(
      '_agnes/v1/mcp.servers.disable',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'disable-snapshot',
      },
      authority,
    )
    await settled(service, disable.operationId)
    const remove = await service.call(
      '_agnes/v1/mcp.servers.remove',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'remove-snapshot',
      },
      authority,
    )
    expect(await settled(service, remove.operationId)).toMatchObject({ state: 'succeeded' })
    expect(JSON.parse(await readFile(store.snapshotPath(profile), 'utf8'))).toMatchObject({ mcp: [] })
    await expect(
      service.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: remove.operationId },
        authority,
      ),
    ).resolves.toMatchObject({ state: 'succeeded' })
  })

  it('imports a legacy preset once, preserves explicit empty authority, and rejects a managed-id collision', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-legacy-nonempty-'))
    const first = new McpResourceStore(directory, scope)
    await first.seedLegacyPreset(profile, [definition])
    await first.seedLegacyPreset(profile, [definition])
    const journal = JSON.parse(await readFile(join(directory, `${profile}.mcp.json`), 'utf8'))
    expect(journal).toMatchObject({ legacyPresetImported: true })
    expect(Object.keys(journal.servers)).toEqual([definition.serverId])
    expect(journal.operations).toEqual([])

    const restarted = new McpResourceStore(directory, scope)
    await restarted.seedLegacyPreset(profile, [definition])
    await expect(
      testService(createResourceControlService(restarted)).call(
        '_agnes/v1/mcp.servers.list',
        { profile },
        authority,
      ),
    ).resolves.toEqual({ items: [expect.objectContaining({ serverId: definition.serverId })] })
    const restartedJournal = JSON.parse(await readFile(join(directory, `${profile}.mcp.json`), 'utf8'))
    expect(restartedJournal).toMatchObject({ legacyPresetImported: true })
    expect(Object.keys(restartedJournal.servers)).toEqual([definition.serverId])

    await rm(directory, { recursive: true, force: true })
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-legacy-empty-'))
    const empty = new McpResourceStore(directory, scope)
    await empty.seedLegacyPreset(profile, [])
    await new McpResourceStore(directory, scope).seedLegacyPreset(profile, [definition])
    await expect(
      testService(createResourceControlService(empty)).call(
        '_agnes/v1/mcp.servers.list',
        { profile },
        authority,
      ),
    ).resolves.toEqual({ items: [] })

    await rm(directory, { recursive: true, force: true })
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-legacy-collision-'))
    const managed = new McpResourceStore(directory, scope, {
      reconcile: async ({ serverId, enabled }) => ({
        status: enabled ? ready(serverId) : { ...ready(serverId), connectionState: 'disabled' as const },
      }),
      reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
      test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
      tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
    })
    const service = testService(createResourceControlService(managed))
    const create = await service.call(
      '_agnes/v1/mcp.servers.create',
      { profile, definition, clientId: 'client', commandId: 'managed-create' },
      authority,
    )
    await settled(service, create.operationId)
    await expect(
      managed.seedLegacyPreset(profile, [{ ...definition, displayName: 'legacy collision' }]),
    ).rejects.toMatchObject({
      data: { code: 'LEGACY_MCP_CONFLICT' },
    })
    expect(
      await service.call('_agnes/v1/mcp.servers.get', { profile, serverId: definition.serverId }, authority),
    ).toMatchObject({ displayName: definition.displayName })
    const collisionJournal = JSON.parse(await readFile(join(directory, `${profile}.mcp.json`), 'utf8'))
    expect(collisionJournal.legacyPresetImported).toBe(false)
  })
})
