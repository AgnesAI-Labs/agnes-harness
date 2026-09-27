import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillCatalogCandidate } from '../src/adapters.js'
import {
  createResourceControlService,
  createSkillResourceStore,
  RESOURCE_ALL_PERMISSIONS,
  type ResourceAuthority,
} from '../src/index.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const profile = 'local-dev'
const scope = { allowedProfiles: [profile] }
const authority: ResourceAuthority = {
  audience: 'admin',
  principalId: 'owner',
  clientId: 'client',
  permissions: RESOURCE_ALL_PERMISSIONS,
}
type TestResult = Readonly<{
  operationId: string
  state: string
  items: readonly Readonly<{ resourceId: string; revision: string; name?: string }>[]
  skillRoots?: readonly Readonly<{
    rootKey: string
    scope: string
    state: string
    workspaceId?: string
  }>[]
}>
type TestService = Omit<ReturnType<typeof createResourceControlService>, 'call'> & {
  call(...args: Parameters<ReturnType<typeof createResourceControlService>['call']>): Promise<TestResult>
}
const testService = (service: ReturnType<typeof createResourceControlService>): TestService =>
  service as TestService
let directory = ''
const candidate = (name = 'skill'): SkillCatalogCandidate => ({
  descriptor: {
    kind: 'skill',
    resourceId: `skill/user/user-agnes/${hash(name)}`,
    name,
    description: 'safe',
    revision: hash(`revision-${name}`),
    sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: hash(`source-${name}`) },
    priority: 400,
    resolution: { winner: true, shadowed: [] },
    trust: 'untrusted',
    desired: 'disabled',
    actual: 'disabled',
    stale: false,
  },
  capabilityHash: hash(`capability-${name}`),
})
async function settled(service: TestService, id: string) {
  return settledFor(service, profile, id)
}
async function settledFor(service: TestService, targetProfile: string, id: string) {
  return vi.waitFor(
    async () => {
      const operation = await service.call(
        '_agnes/v1/resources.operation.get',
        { profile: targetProfile, operationId: id },
        authority,
      )
      expect(['succeeded', 'failed', 'cancelled']).toContain(operation.state)
      return operation
    },
    { timeout: 2_000, interval: 20 },
  )
}
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ''
})

describe('Skill resource control', () => {
  it('keeps Host capability/actual observations private while making refresh/trust/desired idempotent', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skill-control-'))
    const item = candidate()
    const service = testService(
      createResourceControlService(
        createSkillResourceStore({
          directory,
          scope,
          adapter: {
            refresh: async () => [item],
            reconcile: async ({ resources }) =>
              resources.map((resource) => ({
                resourceId: resource.resourceId,
                actual: resource.desired === 'enabled' ? 'ready' : 'disabled',
              })),
          },
        }),
      ),
    )
    const refresh = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'refresh-1' },
      authority,
    )
    expect(await settled(service, refresh.operationId)).toMatchObject({ state: 'succeeded' })
    const listed = await service.call('_agnes/v1/resources.list', { profile }, authority)
    expect(JSON.stringify(listed)).not.toContain(item.capabilityHash)
    expect(listed.skillRoots).toEqual(
      expect.arrayContaining([{ rootKey: 'user-agnes', scope: 'user', state: 'ready' }]),
    )
    const skill = listed.items[0]
    if (!skill) throw new Error('refresh must publish the fixture skill')
    const trust = await service.call(
      '_agnes/v1/skills.trust.set',
      {
        profile,
        resourceId: skill.resourceId,
        expectedRevision: skill.revision,
        trust: 'trusted',
        clientId: 'client',
        commandId: 'trust-1',
      },
      authority,
    )
    await settled(service, trust.operationId)
    const enable = {
      profile,
      resourceId: skill.resourceId,
      state: 'enabled',
      expectedRevision: skill.revision,
      config: { kind: 'none' },
      clientId: 'client',
      commandId: 'enable-1',
    }
    const accepted = await service.call('_agnes/v1/resources.desired.set', enable, authority)
    expect(await service.call('_agnes/v1/resources.desired.set', enable, authority)).toEqual(accepted)
    await expect(
      service.call('_agnes/v1/resources.desired.set', { ...enable, state: 'disabled' }, authority),
    ).rejects.toMatchObject({ data: { code: 'COMMAND_CONFLICT' } })
    await settled(service, accepted.operationId)
    expect(
      await service.call('_agnes/v1/resources.get', { profile, resourceId: skill.resourceId }, authority),
    ).toMatchObject({ trust: 'trusted', desired: 'enabled', actual: 'ready' })
  })

  it('fails closed without a Host adapter and retains the durable desired operation', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skill-control-'))
    const service = testService(createResourceControlService(createSkillResourceStore({ directory, scope })))
    const accepted = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'refresh-no-adapter' },
      authority,
    )
    expect(await settled(service, accepted.operationId)).toMatchObject({
      state: 'failed',
      lastSafeError: { code: 'RESOURCE_RECONCILE_FAILED' },
    })
  })
})

describe('ResourceControlStore admission barrier', () => {
  it('notifies session lifecycle only after a successful durable resource snapshot publication', async () => {
    const { createResourceControlStore } = await import('../src/index.js')
    directory = await mkdtemp(join(tmpdir(), 'agnes-resource-session-refresh-'))
    const item = candidate('lifecycle')
    let fail = false
    const published: string[] = []
    const store = createResourceControlStore({
      directory,
      scope,
      skills: {
        refresh: async () => {
          if (fail) throw new Error('candidate rejected')
          return [item]
        },
        reconcile: async ({ resources }) =>
          resources.map((resource) => ({ resourceId: resource.resourceId, actual: 'disabled' })),
      },
      mcp: {
        reconcile: async () => {
          throw new Error('unused')
        },
        reconnect: async () => {
          throw new Error('unused')
        },
        test: async () => {
          throw new Error('unused')
        },
        tools: async () => ({ serverId: 'unused', catalogRevision: 'a'.repeat(64), items: [] }),
      },
    })
    store.setSuccessfulSnapshotHandler((target) => published.push(target))
    const service = testService(createResourceControlService(store))

    const success = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'lifecycle-success' },
      authority,
    )
    await expect(settled(service, success.operationId)).resolves.toMatchObject({ state: 'succeeded' })
    expect(published).toEqual([profile])

    const listed = await service.call('_agnes/v1/resources.list', { profile }, authority)
    const skill = listed.items[0]
    if (!skill) throw new Error('refresh must publish the lifecycle fixture')
    const trust = await service.call(
      '_agnes/v1/skills.trust.set',
      {
        profile,
        resourceId: skill.resourceId,
        expectedRevision: skill.revision,
        trust: 'trusted',
        clientId: 'client',
        commandId: 'lifecycle-trust',
      },
      authority,
    )
    await expect(settled(service, trust.operationId)).resolves.toMatchObject({ state: 'succeeded' })
    const enable = await service.call(
      '_agnes/v1/resources.desired.set',
      {
        profile,
        resourceId: skill.resourceId,
        expectedRevision: skill.revision,
        state: 'enabled',
        config: { kind: 'none' },
        clientId: 'client',
        commandId: 'lifecycle-enable',
      },
      authority,
    )
    await expect(settled(service, enable.operationId)).resolves.toMatchObject({ state: 'succeeded' })
    const disable = await service.call(
      '_agnes/v1/resources.desired.set',
      {
        profile,
        resourceId: skill.resourceId,
        expectedRevision: skill.revision,
        state: 'disabled',
        config: { kind: 'none' },
        clientId: 'client',
        commandId: 'lifecycle-disable',
      },
      authority,
    )
    await expect(settled(service, disable.operationId)).resolves.toMatchObject({ state: 'succeeded' })
    expect(published).toEqual([profile, profile, profile, profile])

    fail = true
    const failed = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'lifecycle-failed' },
      authority,
    )
    await expect(settled(service, failed.operationId)).resolves.toMatchObject({ state: 'failed' })
    expect(published).toEqual([profile, profile, profile, profile])
  }, 20_000)

  it('returns an operation receipt before a slow driver settles', async () => {
    const { createResourceControlStore } = await import('../src/index.js')
    directory = await mkdtemp(join(tmpdir(), 'agnes-resource-admission-'))
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const item = candidate('slow')
    const store = createResourceControlStore({
      directory,
      scope,
      skills: {
        refresh: async () => {
          await pending
          return [item]
        },
        reconcile: async ({ resources }) =>
          resources.map((resource) => ({ resourceId: resource.resourceId, actual: 'disabled' })),
      },
      mcp: {
        reconcile: async () => {
          throw new Error('unused')
        },
        reconnect: async () => {
          throw new Error('unused')
        },
        test: async () => {
          throw new Error('unused')
        },
        tools: async () => ({ serverId: 'unused', catalogRevision: 'a'.repeat(64), items: [] }),
      },
    })
    const service = testService(createResourceControlService(store))
    const receipt = (await Promise.race([
      service.call(
        '_agnes/v1/skills.refresh',
        { profile, clientId: 'client', commandId: 'slow-refresh' },
        authority,
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('effect receipt was blocked by driver')), 100),
      ),
    ])) as TestResult
    expect(receipt.state).toBe('received')
    release()
    expect(await settled(service, receipt.operationId)).toMatchObject({ state: 'succeeded' })
  })

  it('rejects another profile before a read, journal transaction, or snapshot write', async () => {
    const { createResourceControlStore } = await import('../src/index.js')
    directory = await mkdtemp(join(tmpdir(), 'agnes-resource-profile-scope-'))
    const store = createResourceControlStore({
      directory,
      scope,
      skills: {
        refresh: async () => [],
        reconcile: async () => [],
      },
      mcp: {
        reconcile: async () => {
          throw new Error('unused')
        },
        reconnect: async () => {
          throw new Error('unused')
        },
        test: async () => {
          throw new Error('unused')
        },
        tools: async () => ({ serverId: 'unused', catalogRevision: 'a'.repeat(64), items: [] }),
      },
    })
    const service = testService(createResourceControlService(store))
    const other = 'other-profile'
    await expect(
      service.call('_agnes/v1/resources.list', { profile: other }, authority),
    ).rejects.toMatchObject({ data: { code: 'PROFILE_SCOPE' } })
    await expect(
      service.call(
        '_agnes/v1/mcp.servers.create',
        {
          profile: other,
          definition: {
            serverId: 'other',
            displayName: 'Other',
            transport: { kind: 'stdio', executable: 'other', args: [] },
            secretBinding: { kind: 'none' },
          },
          clientId: 'client',
          commandId: 'other-create',
        },
        authority,
      ),
    ).rejects.toMatchObject({ data: { code: 'PROFILE_SCOPE' } })
    await expect(store.writeWorkerSnapshot(other)).rejects.toMatchObject({ data: { code: 'PROFILE_SCOPE' } })
    await expect(access(join(directory, 'mcp', `${other}.mcp.json`))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(access(join(directory, 'skills', `${other}.skills.json`))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(access(join(directory, 'worker-snapshots', `${other}.json`))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('serializes one profile while an explicitly multi-profile fixture drives independently', async () => {
    const { createResourceControlStore } = await import('../src/index.js')
    directory = await mkdtemp(join(tmpdir(), 'agnes-resource-drive-order-'))
    const started: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let twoStarted!: () => void
    const startedTwo = new Promise<void>((resolve) => {
      twoStarted = resolve
    })
    const fixtureScope = { allowedProfiles: [profile, 'other-profile'] }
    const store = createResourceControlStore({
      directory,
      scope: fixtureScope,
      skills: {
        refresh: async ({ profile: targetProfile, rootKey }) => {
          started.push(`${targetProfile}/${rootKey}`)
          if (started.length === 2) twoStarted()
          await held
          return []
        },
        reconcile: async () => [],
      },
      mcp: {
        reconcile: async () => {
          throw new Error('unused')
        },
        reconnect: async () => {
          throw new Error('unused')
        },
        test: async () => {
          throw new Error('unused')
        },
        tools: async () => ({ serverId: 'unused', catalogRevision: 'a'.repeat(64), items: [] }),
      },
    })
    const service = testService(createResourceControlService(store))
    const first = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, rootKey: 'user-agnes', clientId: 'client', commandId: 'first' },
      authority,
    )
    for (let i = 0; !started.length && i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    const second = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, rootKey: 'user-agents', clientId: 'client', commandId: 'second' },
      authority,
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(started).toEqual([`${profile}/user-agnes`])
    const other = await service.call(
      '_agnes/v1/skills.refresh',
      { profile: 'other-profile', rootKey: 'user-codex', clientId: 'client', commandId: 'other' },
      authority,
    )
    await startedTwo
    expect(started).toContain('other-profile/user-codex')
    release()
    await expect(settledFor(service, profile, first.operationId)).resolves.toMatchObject({
      state: 'succeeded',
    })
    await expect(settledFor(service, profile, second.operationId)).resolves.toMatchObject({
      state: 'succeeded',
    })
    await expect(settledFor(service, 'other-profile', other.operationId)).resolves.toMatchObject({
      state: 'succeeded',
    })
    expect(started).toEqual([`${profile}/user-agnes`, 'other-profile/user-codex', `${profile}/user-agents`])
  })

  it('does not route a denied Skill operation lookup to MCP', async () => {
    const { createResourceControlStore } = await import('../src/index.js')
    directory = await mkdtemp(join(tmpdir(), 'agnes-resource-operation-owner-'))
    const store = createResourceControlStore({
      directory,
      scope,
      skills: {
        refresh: async () => [],
        reconcile: async () => [],
      },
      mcp: {
        reconcile: async () => {
          throw new Error('MCP must not receive a denied Skill lookup')
        },
        reconnect: async () => {
          throw new Error('unused')
        },
        test: async () => {
          throw new Error('unused')
        },
        tools: async () => ({ serverId: 'unused', catalogRevision: 'a'.repeat(64), items: [] }),
      },
    })
    const service = testService(createResourceControlService(store))
    const receipt = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'owner-refresh' },
      authority,
    )
    const otherAuthority: ResourceAuthority = {
      ...authority,
      principalId: 'another-admin',
      clientId: 'another-client',
      permissions: ['resources.read'],
    }
    await expect(
      service.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: receipt.operationId },
        otherAuthority,
      ),
    ).rejects.toMatchObject({ data: { code: 'RESOURCE_OPERATION_OWNER_REQUIRED' } })
    await settled(service, receipt.operationId)
  })
})

describe('Skill root persistence and workspace binding', () => {
  it('persists empty, stale, and unavailable as distinct root states', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skill-root-states-'))
    const workspaceId = hash('workspace-a')
    const item = candidate('kept')
    let mode: 'ready' | 'empty' | 'fail-lkg' | 'fail-none' = 'ready'
    const service = testService(
      createSkillResourceStore({
        directory,
        scope,
        adapter: {
          refresh: async () => {
            if (mode === 'ready')
              return {
                candidates: [item],
                failedRoots: [],
                roots: [
                  { rootKey: 'user-agnes', scope: 'user', state: 'ready' },
                  { rootKey: 'workspace-agnes', scope: 'workspace', state: 'empty', workspaceId },
                ],
              }
            if (mode === 'empty')
              return {
                candidates: [],
                failedRoots: [],
                roots: [{ rootKey: 'user-agnes', scope: 'user', state: 'empty' }],
              }
            if (mode === 'fail-lkg')
              return {
                candidates: [item],
                failedRoots: ['user-agnes'],
                roots: [{ rootKey: 'user-agnes', scope: 'user', state: 'stale' }],
              }
            return {
              candidates: [],
              failedRoots: ['user-agnes'],
              roots: [{ rootKey: 'user-agnes', scope: 'user', state: 'unavailable' }],
            }
          },
          reconcile: async ({ resources }) =>
            resources.map((resource) => ({ resourceId: resource.resourceId, actual: 'disabled' })),
        },
      }),
    )
    const first = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'roots-ready' },
      authority,
    )
    expect(await settled(service, first.operationId)).toMatchObject({ state: 'succeeded' })
    expect((await service.call('_agnes/v1/resources.list', { profile }, authority)).skillRoots).toEqual(
      expect.arrayContaining([
        { rootKey: 'user-agnes', scope: 'user', state: 'ready' },
        expect.objectContaining({ rootKey: 'workspace-agnes', state: 'empty', workspaceId }),
      ]),
    )
    mode = 'fail-lkg'
    const stale = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'roots-stale' },
      authority,
    )
    expect(await settled(service, stale.operationId)).toMatchObject({ state: 'succeeded' })
    expect((await service.call('_agnes/v1/resources.list', { profile }, authority)).skillRoots).toEqual(
      expect.arrayContaining([{ rootKey: 'user-agnes', scope: 'user', state: 'stale' }]),
    )
  })

  it('records unavailable when a failed refresh has no last-known-good', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skill-root-unavailable-'))
    const service = testService(
      createSkillResourceStore({
        directory,
        scope,
        adapter: {
          refresh: async () => {
            throw new Error('scan failed')
          },
          reconcile: async () => [],
        },
      }),
    )
    const accepted = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'roots-unavailable' },
      authority,
    )
    expect(await settled(service, accepted.operationId)).toMatchObject({ state: 'failed' })
    const listed = await service.call('_agnes/v1/resources.list', { profile }, authority)
    expect(listed.skillRoots).toEqual(
      expect.arrayContaining([{ rootKey: 'user-agnes', scope: 'user', state: 'unavailable' }]),
    )
  })

  it('rejects an unknown workspaceId before scanning and does not accept a filesystem path', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skill-workspace-bind-'))
    let scanned = 0
    const known = hash('/catalog/project')
    const { createResourceControlService } = await import('../src/index.js')
    const { rpcError } = await import('@agnes/protocol')
    const service = testService(
      createResourceControlService(
        createSkillResourceStore({
          directory,
          scope,
          resolveWorkspaceId: async (workspaceId) => {
            if (!workspaceId || workspaceId === known) return known
            throw rpcError('SEMANTIC_REJECTED', { code: 'WORKSPACE_NOT_FOUND' })
          },
          adapter: {
            refresh: async () => {
              scanned += 1
              return []
            },
            reconcile: async () => [],
          },
        }),
      ),
    )
    await expect(
      service.call(
        '_agnes/v1/skills.refresh',
        { profile, clientId: 'client', commandId: 'refresh-unknown', workspaceId: hash('/not/registered') },
        authority,
      ),
    ).rejects.toMatchObject({ data: { code: 'WORKSPACE_NOT_FOUND' } })
    expect(scanned).toBe(0)
    await expect(
      service.call(
        '_agnes/v1/skills.refresh',
        { profile, clientId: 'client', commandId: 'refresh-path', path: '/catalog/project' },
        authority,
      ),
    ).rejects.toMatchObject({ data: { code: 'INVALID_PARAMS' } })
    expect(scanned).toBe(0)
  })

  it('lists only the bound workspace Skill items', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skill-workspace-list-'))
    const firstId = hash('/ws/a')
    const secondId = hash('/ws/b')
    const first = {
      descriptor: {
        kind: 'skill' as const,
        resourceId: `skill/workspace/workspace-agnes/${hash('a')}`,
        name: 'alpha',
        revision: hash('rev-a'),
        sourceIdentity: {
          scope: 'workspace' as const,
          rootKey: 'workspace-agnes' as const,
          sourceId: hash('src-a'),
        },
        priority: 500,
        resolution: { winner: true, shadowed: [] },
        trust: 'untrusted' as const,
        desired: 'disabled' as const,
        actual: 'disabled' as const,
        stale: false,
        workspaceId: firstId,
      },
      capabilityHash: hash('cap-a'),
    }
    const second = {
      descriptor: {
        ...first.descriptor,
        resourceId: `skill/workspace/workspace-agnes/${hash('b')}`,
        name: 'beta',
        workspaceId: secondId,
      },
      capabilityHash: hash('cap-b'),
    }
    const service = testService(
      createSkillResourceStore({
        directory,
        scope,
        adapter: {
          refresh: async ({ workspaceId }) =>
            workspaceId === secondId
              ? {
                  candidates: [second],
                  failedRoots: [],
                  roots: [
                    {
                      rootKey: 'workspace-agnes',
                      scope: 'workspace',
                      state: 'ready',
                      workspaceId: secondId,
                    },
                  ],
                }
              : {
                  candidates: [first],
                  failedRoots: [],
                  roots: [
                    {
                      rootKey: 'workspace-agnes',
                      scope: 'workspace',
                      state: 'ready',
                      workspaceId: firstId,
                    },
                  ],
                },
          reconcile: async ({ resources }) =>
            resources.map((resource) => ({ resourceId: resource.resourceId, actual: 'disabled' })),
        },
      }),
    )
    const one = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'ws-a', workspaceId: firstId },
      authority,
    )
    await settled(service, one.operationId)
    const two = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'ws-b', workspaceId: secondId },
      authority,
    )
    await settled(service, two.operationId)
    const listedA = await service.call(
      '_agnes/v1/resources.list',
      { profile, kind: 'skill', workspaceId: firstId },
      authority,
    )
    const listedB = await service.call(
      '_agnes/v1/resources.list',
      { profile, kind: 'skill', workspaceId: secondId },
      authority,
    )
    expect(listedA.items.map((item) => item.name)).toEqual(['alpha'])
    expect(listedB.items.map((item) => item.name)).toEqual(['beta'])
  })

  it('loads a v2 journal without roots and writes v4 after the next refresh', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skill-journal-v2-'))
    const item = candidate('legacy')
    await writeFile(
      join(directory, `${profile}.skills.json`),
      JSON.stringify({
        version: 2,
        discovered: [item.descriptor],
        capability: { [item.descriptor.resourceId]: item.capabilityHash },
        trust: {},
        desired: {},
        actual: {},
        operations: [],
      }),
    )
    const service = testService(
      createSkillResourceStore({
        directory,
        scope,
        adapter: {
          refresh: async () => ({
            candidates: [item],
            failedRoots: [],
            roots: [{ rootKey: 'user-agnes', scope: 'user', state: 'ready' }],
          }),
          reconcile: async ({ resources }) =>
            resources.map((resource) => ({ resourceId: resource.resourceId, actual: 'disabled' })),
        },
      }),
    )
    const listed = await service.call('_agnes/v1/resources.list', { profile }, authority)
    expect(listed.items).toHaveLength(1)
    const refresh = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'v2-migrate' },
      authority,
    )
    expect(await settled(service, refresh.operationId)).toMatchObject({ state: 'succeeded' })
    const raw = JSON.parse(await readFile(join(directory, `${profile}.skills.json`), 'utf8')) as {
      version: number
      roots: unknown[]
    }
    expect(raw.version).toBe(4)
    expect(raw.roots).toEqual(
      expect.arrayContaining([{ rootKey: 'user-agnes', scope: 'user', state: 'ready' }]),
    )
  })

  it('drops a removed winner and keeps the explicit decision of the same-name Skill that takes over', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skill-no-auto-promote-'))
    const winner = {
      descriptor: {
        kind: 'skill' as const,
        resourceId: `skill/workspace/workspace-agnes/${hash('high')}`,
        name: 'review',
        revision: hash('rev-high'),
        sourceIdentity: {
          scope: 'workspace' as const,
          rootKey: 'workspace-agnes' as const,
          sourceId: hash('src-high'),
        },
        priority: 500,
        resolution: { winner: true, shadowed: [] },
        trust: 'untrusted' as const,
        desired: 'disabled' as const,
        actual: 'disabled' as const,
        stale: false,
        workspaceId: hash('/ws/a'),
      },
      capabilityHash: hash('cap-high'),
    }
    const shadowed = {
      descriptor: {
        kind: 'skill' as const,
        resourceId: `skill/user/user-agnes/${hash('low')}`,
        name: 'review',
        revision: hash('rev-low'),
        sourceIdentity: {
          scope: 'user' as const,
          rootKey: 'user-agnes' as const,
          sourceId: hash('src-low'),
        },
        priority: 400,
        resolution: { winner: false, shadowed: [] },
        trust: 'untrusted' as const,
        desired: 'disabled' as const,
        actual: 'disabled' as const,
        stale: false,
      },
      capabilityHash: hash('cap-low'),
    }
    let includeWinner = true
    const service = testService(
      createSkillResourceStore({
        directory,
        scope,
        adapter: {
          refresh: async () =>
            includeWinner
              ? {
                  candidates: [winner, shadowed],
                  failedRoots: [],
                  roots: [
                    {
                      rootKey: 'workspace-agnes',
                      scope: 'workspace',
                      state: 'ready',
                      workspaceId: winner.descriptor.workspaceId,
                    },
                    { rootKey: 'user-agnes', scope: 'user', state: 'ready' },
                  ],
                }
              : {
                  candidates: [shadowed],
                  failedRoots: [],
                  roots: [
                    {
                      rootKey: 'workspace-agnes',
                      scope: 'workspace',
                      state: 'empty',
                      workspaceId: winner.descriptor.workspaceId,
                    },
                    { rootKey: 'user-agnes', scope: 'user', state: 'ready' },
                  ],
                },
          reconcile: async ({ resources }) =>
            resources.map((resource) => ({
              resourceId: resource.resourceId,
              actual: resource.desired === 'enabled' ? 'ready' : 'disabled',
            })),
        },
      }),
    )
    const first = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'promote-1' },
      authority,
    )
    await settled(service, first.operationId)
    const trust = await service.call(
      '_agnes/v1/skills.trust.set',
      {
        profile,
        resourceId: winner.descriptor.resourceId,
        expectedRevision: winner.descriptor.revision,
        trust: 'trusted',
        clientId: 'client',
        commandId: 'promote-trust',
      },
      authority,
    )
    await settled(service, trust.operationId)
    const enable = await service.call(
      '_agnes/v1/resources.desired.set',
      {
        profile,
        resourceId: winner.descriptor.resourceId,
        state: 'enabled',
        expectedRevision: winner.descriptor.revision,
        config: { kind: 'none' },
        clientId: 'client',
        commandId: 'promote-enable',
      },
      authority,
    )
    await settled(service, enable.operationId)
    const disableShadowed = await service.call(
      '_agnes/v1/resources.desired.set',
      {
        profile,
        resourceId: shadowed.descriptor.resourceId,
        state: 'disabled',
        expectedRevision: shadowed.descriptor.revision,
        config: { kind: 'none' },
        clientId: 'client',
        commandId: 'shadowed-disable',
      },
      authority,
    )
    await settled(service, disableShadowed.operationId)
    includeWinner = false
    const second = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'promote-2' },
      authority,
    )
    await settled(service, second.operationId)
    const listed = await service.call('_agnes/v1/resources.list', { profile, kind: 'skill' }, authority)
    expect(listed.items.map((item) => item.resourceId)).toEqual([shadowed.descriptor.resourceId])
    expect(listed.items[0]).toMatchObject({ name: 'review', trust: 'trusted', desired: 'disabled' })
  })

  it('keeps bound workspace Skills and their trust when only a user root is refreshed', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skill-user-root-refresh-'))
    const workspaceId = hash('/ws/bound')
    const workspace = {
      descriptor: {
        kind: 'skill' as const,
        resourceId: `skill/workspace/workspace-agnes/${hash('ws-skill')}`,
        name: 'ws-skill',
        revision: hash('rev-ws-skill'),
        sourceIdentity: {
          scope: 'workspace' as const,
          rootKey: 'workspace-agnes' as const,
          sourceId: hash('src-ws-skill'),
        },
        priority: 500,
        resolution: { winner: true, shadowed: [] },
        trust: 'untrusted' as const,
        desired: 'disabled' as const,
        actual: 'disabled' as const,
        stale: false,
        workspaceId,
      },
      capabilityHash: hash('cap-ws-skill'),
    }
    const user = candidate('user-skill')
    const workspaceRoot = {
      rootKey: 'workspace-agnes',
      scope: 'workspace',
      state: 'ready',
      workspaceId,
    } as const
    const userRoot = { rootKey: 'user-agnes', scope: 'user', state: 'ready' } as const
    let workspaceScanEmpty = false
    const service = testService(
      createSkillResourceStore({
        directory,
        scope,
        // Mirrors the daemon: an omitted workspaceId binds to the resource default workspace.
        resolveWorkspaceId: async () => workspaceId,
        adapter: {
          // Mirrors the daemon adapter: observations are filtered to the requested rootKey.
          refresh: async ({ rootKey }) => {
            if (rootKey === 'user-agnes') return { candidates: [user], failedRoots: [], roots: [userRoot] }
            if (rootKey === 'workspace-agnes')
              return workspaceScanEmpty
                ? { candidates: [], failedRoots: [], roots: [{ ...workspaceRoot, state: 'empty' as const }] }
                : { candidates: [workspace], failedRoots: [], roots: [workspaceRoot] }
            return { candidates: [workspace, user], failedRoots: [], roots: [workspaceRoot, userRoot] }
          },
          reconcile: async ({ resources }) =>
            resources.map((resource) => ({
              resourceId: resource.resourceId,
              actual: resource.desired === 'enabled' ? 'ready' : 'disabled',
            })),
        },
      }),
    )
    const run = async (params: Record<string, unknown>) => {
      const receipt = await service.call(
        '_agnes/v1/skills.refresh',
        { profile, clientId: 'client', ...params },
        authority,
      )
      return settled(service, receipt.operationId)
    }
    const settle = async (method: string, params: Record<string, unknown>) => {
      const receipt = await service.call(
        method as never,
        { profile, clientId: 'client', ...params },
        authority,
      )
      return settled(service, receipt.operationId)
    }
    const workspaceItem = async () =>
      (
        await service.call('_agnes/v1/resources.list', { profile, kind: 'skill', workspaceId }, authority)
      ).items.find((item) => item.resourceId === workspace.descriptor.resourceId)

    await run({ commandId: 'initial' })
    await settle('_agnes/v1/skills.trust.set', {
      resourceId: workspace.descriptor.resourceId,
      expectedRevision: workspace.descriptor.revision,
      trust: 'trusted',
      commandId: 'trust-ws',
    })
    await settle('_agnes/v1/resources.desired.set', {
      resourceId: workspace.descriptor.resourceId,
      state: 'enabled',
      expectedRevision: workspace.descriptor.revision,
      config: { kind: 'none' },
      commandId: 'enable-ws',
    })

    expect(await run({ commandId: 'user-only', rootKey: 'user-agnes' })).toMatchObject({ state: 'succeeded' })
    expect(await workspaceItem()).toMatchObject({ trust: 'trusted', desired: 'enabled' })

    workspaceScanEmpty = true
    expect(await run({ commandId: 'workspace-only', rootKey: 'workspace-agnes' })).toMatchObject({
      state: 'succeeded',
    })
    expect(await workspaceItem()).toBeUndefined()
  })
})

it('persists priority overrides, rejects stale saves, resets defaults and permanently fences deletion', async () => {
  directory = await mkdtemp(join(tmpdir(), 'agnes-skill-management-'))
  const item = candidate()
  let deletes = 0
  const adapter = {
    validateRemove: async () => undefined,
    refresh: async () => [item],
    remove: async () => {
      deletes++
    },
    reconcile: async ({ resources }: { resources: readonly { resourceId: string }[] }) =>
      resources.map((resource) => ({ resourceId: resource.resourceId, actual: 'disabled' as const })),
  }
  const store = createSkillResourceStore({ directory, scope, adapter })
  const service = testService(createResourceControlService(store))
  const command = {
    profile,
    clientId: 'client',
    resourceId: item.descriptor.resourceId,
    expectedRevision: item.descriptor.revision,
  }
  const refresh = await service.call(
    '_agnes/v1/skills.refresh',
    { profile, clientId: 'client', commandId: 'r' },
    authority,
  )
  await settled(service, refresh.operationId)
  const update = await service.call(
    '_agnes/v1/skills.priority.set',
    { ...command, commandId: 'p', expectedPriority: 400, priority: 499 },
    authority,
  )
  expect(await settled(service, update.operationId)).toMatchObject({ state: 'succeeded' })
  expect((await store.workerControl(profile)).priorities[item.descriptor.resourceId]).toBe(499)
  await expect(
    service.call(
      '_agnes/v1/skills.priority.set',
      { ...command, commandId: 'stale', expectedPriority: 400, priority: 450 },
      authority,
    ),
  ).rejects.toMatchObject({ data: { code: 'REVISION_CONFLICT' } })
  const reset = await service.call(
    '_agnes/v1/skills.priority.set',
    { ...command, commandId: 'reset', expectedPriority: 499, priority: null },
    authority,
  )
  await settled(service, reset.operationId)
  expect((await store.workerControl(profile)).priorities[item.descriptor.resourceId]).toBeUndefined()
  await expect(
    service.call(
      '_agnes/v1/skills.remove',
      { ...command, commandId: 'denied' },
      { ...authority, permissions: ['resources.read'] },
    ),
  ).rejects.toBeDefined()
  const removed = await service.call(
    '_agnes/v1/skills.remove',
    { ...command, commandId: 'remove' },
    authority,
  )
  expect(await settled(service, removed.operationId)).toMatchObject({ state: 'succeeded' })
  await service.call('_agnes/v1/skills.remove', { ...command, commandId: 'remove' }, authority)
  expect(deletes).toBe(1)
  const restored = createSkillResourceStore({ directory, scope, adapter })
  expect((await restored.workerControl(profile)).removed).toContain(item.descriptor.resourceId)
  const rescan = await service.call(
    '_agnes/v1/skills.refresh',
    { profile, clientId: 'client', commandId: 'rescan' },
    authority,
  )
  await settled(service, rescan.operationId)
  expect((await service.call('_agnes/v1/resources.list', { profile }, authority)).items).toEqual([])
})

it('reinstalls a deleted Skill only with an approved exact refresh, never an ordinary scan', async () => {
  directory = await mkdtemp(join(tmpdir(), 'agnes-skill-reinstall-'))
  const item = candidate('reinstall')
  let removedOnScan = false
  const store = createSkillResourceStore({
    directory,
    scope,
    adapter: {
      validateRemove: async () => undefined,
      remove: async () => undefined,
      refresh: async () => [
        {
          ...item,
          descriptor: {
            ...item.descriptor,
            resolution: { winner: !removedOnScan, shadowed: [] },
            actual: removedOnScan ? 'unavailable' : 'disabled',
          },
        },
      ],
      reconcile: async ({ resources }) =>
        resources.map((resource) => ({
          resourceId: resource.resourceId,
          actual: 'disabled',
          resolution: { winner: true, shadowed: [] },
        })),
    },
  })
  const service = testService(createResourceControlService(store))
  const scan = async (commandId: string, reinstall?: { resourceId: string; expectedRevision: string }) => {
    const receipt = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId, rootKey: 'user-agnes', ...(reinstall ? { reinstall } : {}) },
      authority,
    )
    return settled(service, receipt.operationId)
  }
  expect(await scan('initial')).toMatchObject({ state: 'succeeded' })
  const removed = await service.call(
    '_agnes/v1/skills.remove',
    {
      profile,
      clientId: 'client',
      commandId: 'delete',
      resourceId: item.descriptor.resourceId,
      expectedRevision: item.descriptor.revision,
    },
    authority,
  )
  expect(await settled(service, removed.operationId)).toMatchObject({ state: 'succeeded' })
  removedOnScan = true
  expect(await scan('watcher')).toMatchObject({ state: 'succeeded' })
  expect((await service.call('_agnes/v1/resources.list', { profile }, authority)).items).toEqual([])
  const reinstall = {
    resourceId: item.descriptor.resourceId,
    expectedRevision: item.descriptor.revision,
  }
  await expect(
    service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'no-write', rootKey: 'user-agnes', reinstall },
      { ...authority, permissions: ['skills.refresh', 'resources.read'] },
    ),
  ).rejects.toMatchObject({ data: { code: 'SKILL_REINSTALL_AUTHORITY_REQUIRED' } })
  expect(await scan('wrong-revision', { ...reinstall, expectedRevision: hash('wrong') })).toMatchObject({
    state: 'failed',
  })
  expect((await store.workerControl(profile)).removed).toContain(item.descriptor.resourceId)
  expect(await scan('approved', reinstall)).toMatchObject({ state: 'succeeded' })
  expect((await store.workerControl(profile)).removed).not.toContain(item.descriptor.resourceId)
  expect(
    await service.call('_agnes/v1/resources.get', { profile, resourceId: reinstall.resourceId }, authority),
  ).toMatchObject({ revision: reinstall.expectedRevision, resolution: { winner: true } })
})

it('keeps a failed deletion fenced across restart and allows an explicit deletion retry', async () => {
  directory = await mkdtemp(join(tmpdir(), 'agnes-skill-remove-failure-'))
  const item = candidate()
  let refuse = true
  const adapter = {
    validateRemove: async () => undefined,
    refresh: async () => [item],
    remove: async () => {
      if (refuse) throw new Error('disk refused')
    },
    reconcile: async ({ resources }: { resources: readonly { resourceId: string }[] }) =>
      resources.map((resource) => ({ resourceId: resource.resourceId, actual: 'disabled' as const })),
  }
  let store = createSkillResourceStore({ directory, scope, adapter })
  let service = testService(createResourceControlService(store))
  const r = await service.call(
    '_agnes/v1/skills.refresh',
    { profile, clientId: 'client', commandId: 'scan' },
    authority,
  )
  await settled(service, r.operationId)
  const params = {
    profile,
    clientId: 'client',
    resourceId: item.descriptor.resourceId,
    expectedRevision: item.descriptor.revision,
  }
  const d = await service.call('_agnes/v1/skills.remove', { ...params, commandId: 'delete' }, authority)
  expect(await settled(service, d.operationId)).toMatchObject({ state: 'failed' })
  store = createSkillResourceStore({ directory, scope, adapter })
  service = testService(createResourceControlService(store))
  expect((await store.workerControl(profile)).removed).toContain(item.descriptor.resourceId)
  await expect(
    service.call(
      '_agnes/v1/resources.desired.set',
      { ...params, commandId: 'enable', state: 'enabled', config: { kind: 'none' } },
      authority,
    ),
  ).rejects.toMatchObject({ data: { code: 'SKILL_REMOVED' } })
  refuse = false
  const retry = await service.call('_agnes/v1/skills.remove', { ...params, commandId: 'retry' }, authority)
  expect(await settled(service, retry.operationId)).toMatchObject({ state: 'succeeded' })
})

it('rejects deletion preflight without persisting a tombstone or changing desired state', async () => {
  directory = await mkdtemp(join(tmpdir(), 'agnes-skill-preflight-'))
  const item = candidate()
  let attempts = 0
  const store = createSkillResourceStore({
    directory,
    scope,
    adapter: {
      refresh: async () => [item],
      reconcile: async ({ resources }) =>
        resources.map((resource) => ({ resourceId: resource.resourceId, actual: 'disabled' })),
      validateRemove: async () => {
        attempts++
        throw new Error('unsupported path')
      },
      remove: async () => {
        throw new Error('must not delete after a failed preflight')
      },
    },
  })
  const service = testService(createResourceControlService(store))
  const scan = await service.call(
    '_agnes/v1/skills.refresh',
    { profile, clientId: 'client', commandId: 'scan' },
    authority,
  )
  await settled(service, scan.operationId)
  const before = await store.workerControl(profile)
  const request = {
    profile,
    clientId: 'client',
    commandId: 'delete',
    resourceId: item.descriptor.resourceId,
    expectedRevision: item.descriptor.revision,
  }
  await expect(service.call('_agnes/v1/skills.remove', request, authority)).rejects.toMatchObject({
    data: { code: 'SKILL_DELETE_PREFLIGHT_FAILED' },
  })
  expect(await store.workerControl(profile)).toEqual(before)
  await expect(service.call('_agnes/v1/skills.remove', request, authority)).rejects.toMatchObject({
    data: { code: 'SKILL_DELETE_PREFLIGHT_FAILED' },
  })
  expect(attempts).toBe(2)
  expect(await createSkillResourceStore({ directory, scope }).workerControl(profile)).toEqual(before)
})

describe('Skill default trust policy', () => {
  const revised = (item: SkillCatalogCandidate, suffix: string): SkillCatalogCandidate => ({
    descriptor: { ...item.descriptor, revision: hash(`${item.descriptor.revision}-${suffix}`) },
    capabilityHash: hash(`${item.capabilityHash}-${suffix}`),
  })
  const fixture = async (initial: SkillCatalogCandidate[]) => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skill-default-trust-'))
    let observed = initial
    const service = testService(
      createSkillResourceStore({
        directory,
        scope,
        adapter: {
          refresh: async () => observed,
          reconcile: async ({ resources }) =>
            resources.map((resource) => ({
              resourceId: resource.resourceId,
              actual: resource.trust === 'trusted' && resource.desired === 'enabled' ? 'ready' : 'disabled',
            })),
        },
      }),
    )
    let command = 0
    const run = async (method: string, params: Record<string, unknown> = {}) => {
      const receipt = await service.call(
        method as never,
        { profile, clientId: 'client', commandId: `c${command++}`, ...params },
        authority,
      )
      return settled(service, receipt.operationId)
    }
    const item = async (resourceId: string) =>
      (await service.call('_agnes/v1/resources.list', { profile, kind: 'skill' }, authority)).items.find(
        (entry) => entry.resourceId === resourceId,
      ) as Record<string, unknown> | undefined
    return {
      run,
      item,
      observe: (next: SkillCatalogCandidate[]) => {
        observed = next
      },
    }
  }

  it('trusts and enables a Skill the first time it is discovered', async () => {
    const skill = candidate('fresh')
    const f = await fixture([skill])
    await f.run('_agnes/v1/skills.refresh')
    expect(await f.item(skill.descriptor.resourceId)).toMatchObject({
      trust: 'trusted',
      desired: 'enabled',
      actual: 'ready',
    })
  })

  it('carries an existing decision over to the edited revision', async () => {
    const skill = candidate('edited')
    const f = await fixture([skill])
    await f.run('_agnes/v1/skills.refresh')
    const edited = revised(skill, 'v2')
    f.observe([edited])
    await f.run('_agnes/v1/skills.refresh')
    expect(await f.item(skill.descriptor.resourceId)).toMatchObject({
      revision: edited.descriptor.revision,
      trust: 'trusted',
      desired: 'enabled',
      actual: 'ready',
    })
  })

  it('keeps an explicit rejection and an explicit disable across an edit', async () => {
    const rejected = candidate('rejected')
    const disabled = candidate('disabled')
    const f = await fixture([rejected, disabled])
    await f.run('_agnes/v1/skills.refresh')
    await f.run('_agnes/v1/skills.trust.set', {
      resourceId: rejected.descriptor.resourceId,
      expectedRevision: rejected.descriptor.revision,
      trust: 'rejected',
    })
    await f.run('_agnes/v1/resources.desired.set', {
      resourceId: disabled.descriptor.resourceId,
      expectedRevision: disabled.descriptor.revision,
      state: 'disabled',
      config: { kind: 'none' },
    })
    f.observe([revised(rejected, 'v2'), revised(disabled, 'v2')])
    await f.run('_agnes/v1/skills.refresh')
    expect(await f.item(rejected.descriptor.resourceId)).toMatchObject({
      trust: 'rejected',
      actual: 'disabled',
    })
    expect(await f.item(disabled.descriptor.resourceId)).toMatchObject({
      trust: 'trusted',
      desired: 'disabled',
      actual: 'disabled',
    })
  })

  it('does not trust a Skill already known before this policy', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skill-default-trust-legacy-'))
    const legacy = candidate('legacy-known')
    await writeFile(
      join(directory, `${profile}.skills.json`),
      JSON.stringify({
        version: 2,
        discovered: [legacy.descriptor],
        capability: { [legacy.descriptor.resourceId]: legacy.capabilityHash },
        trust: {},
        desired: {},
        actual: {},
        operations: [],
      }),
    )
    const service = testService(
      createSkillResourceStore({
        directory,
        scope,
        adapter: {
          refresh: async () => [legacy],
          reconcile: async ({ resources }) =>
            resources.map((resource) => ({ resourceId: resource.resourceId, actual: 'disabled' })),
        },
      }),
    )
    const receipt = await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'legacy' },
      authority,
    )
    await settled(service, receipt.operationId)
    const listed = await service.call('_agnes/v1/resources.list', { profile, kind: 'skill' }, authority)
    expect(listed.items[0]).toMatchObject({ trust: 'untrusted', desired: 'disabled' })
  })
})

it('keeps a skipped Skill and its decisions as stale and restores them when it is fixed', async () => {
  directory = await mkdtemp(join(tmpdir(), 'agnes-skill-skipped-'))
  const skill = candidate('flaky')
  let broken = false
  const service = testService(
    createSkillResourceStore({
      directory,
      scope,
      adapter: {
        refresh: async () =>
          broken
            ? { candidates: [], failedRoots: [], skippedResourceIds: [skill.descriptor.resourceId] }
            : { candidates: [skill], failedRoots: [] },
        reconcile: async ({ resources }) =>
          resources.map((resource) => ({
            resourceId: resource.resourceId,
            actual: resource.trust === 'trusted' && resource.desired === 'enabled' ? 'ready' : 'disabled',
          })),
      },
    }),
  )
  let command = 0
  const run = async (method: string, params: Record<string, unknown> = {}) => {
    const receipt = await service.call(
      method as never,
      { profile, clientId: 'client', commandId: `skip-${command++}`, ...params },
      authority,
    )
    return settled(service, receipt.operationId)
  }
  const item = async () =>
    (await service.call('_agnes/v1/resources.list', { profile, kind: 'skill' }, authority)).items[0] as
      | Record<string, unknown>
      | undefined
  await run('_agnes/v1/skills.refresh')
  await run('_agnes/v1/resources.desired.set', {
    resourceId: skill.descriptor.resourceId,
    expectedRevision: skill.descriptor.revision,
    state: 'disabled',
    config: { kind: 'none' },
  })
  broken = true
  await run('_agnes/v1/skills.refresh')
  expect(await item()).toMatchObject({
    resourceId: skill.descriptor.resourceId,
    stale: true,
    desired: 'disabled',
  })
  broken = false
  await run('_agnes/v1/skills.refresh')
  expect(await item()).toMatchObject({ stale: false, trust: 'trusted', desired: 'disabled' })
})
