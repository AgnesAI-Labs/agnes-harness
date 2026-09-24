import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jcs, type ResourceOperation, type ResourceOperationReceipt } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillCatalogCandidate } from '../src/adapters.js'
import {
  createResourceControlService,
  createResourceControlStore,
  createSkillResourceStore,
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
const revision = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
const definition = {
  serverId: 'example',
  displayName: 'Example',
  transport: { kind: 'stdio' as const, executable: 'example-mcp', args: [] },
  secretBinding: { kind: 'none' as const },
}
const candidate: SkillCatalogCandidate = {
  descriptor: {
    kind: 'skill' as const,
    resourceId: `skill/user/user-agnes/${'a'.repeat(64)}`,
    name: 'review',
    description: 'Review a change',
    revision: 'b'.repeat(64),
    sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: 'c'.repeat(64) },
    priority: 400,
    resolution: { winner: true, shadowed: [] },
    trust: 'untrusted' as const,
    desired: 'disabled' as const,
    actual: 'disabled' as const,
    stale: false,
  },
  capabilityHash: 'd'.repeat(64),
}
type TestService = Omit<ReturnType<typeof createResourceControlService>, 'call'> & {
  call(...args: Parameters<ReturnType<typeof createResourceControlService>['call']>): Promise<unknown>
}
const serviceFor = (service: ReturnType<typeof createResourceControlService>): TestService => service
let directory = ''
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ''
})

async function settled(service: TestService, operationId: string): Promise<ResourceOperation> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = await service.call(
      '_agnes/v1/resources.operation.get',
      { profile, operationId },
      authority,
    )
    const checked = operation as ResourceOperation
    if (['succeeded', 'failed', 'cancelled'].includes(checked.state)) return checked
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('operation did not settle')
}

async function operationCount(path: string): Promise<number> {
  return (JSON.parse(await readFile(path, 'utf8')) as { operations: unknown[] }).operations.length
}

async function terminalize(
  path: string,
  operationId: string,
  state: ResourceOperation['state'],
): Promise<void> {
  const journal = JSON.parse(await readFile(path, 'utf8')) as {
    operations: Array<{ operation: ResourceOperation }>
  }
  const row = journal.operations.find((entry) => entry.operation.operationId === operationId)
  if (!row) throw new Error('fixture operation was not persisted')
  row.operation = { ...row.operation, state, progress: 100, updatedAt: new Date().toISOString() }
  await writeFile(path, JSON.stringify(journal))
}

describe('terminal cancellation admission', () => {
  it('rejects terminal Skill work without changing the original operation or journal', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-terminal-skill-'))
    const service = serviceFor(
      createResourceControlService(
        createSkillResourceStore({
          directory,
          scope,
          adapter: { refresh: async () => [candidate], reconcile: async () => [] },
        }),
      ),
    )
    const created = (await service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'skill-create' },
      authority,
    )) as ResourceOperationReceipt
    await settled(service, created.operationId)
    const journal = join(directory, `${profile}.skills.json`)
    const count = await operationCount(journal)

    for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
      await terminalize(journal, created.operationId, state)
      const before = (await service.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: created.operationId },
        authority,
      )) as ResourceOperation
      await expect(
        service.call(
          '_agnes/v1/resources.operation.cancel',
          {
            profile,
            operationId: created.operationId,
            clientId: 'client',
            commandId: `skill-terminal-${state}`,
          },
          authority,
        ),
      ).rejects.toMatchObject({ data: { code: 'RESOURCE_OPERATION_TERMINAL' } })
      await expect(
        service.call(
          '_agnes/v1/resources.operation.get',
          { profile, operationId: created.operationId },
          authority,
        ),
      ).resolves.toEqual(before)
      await expect(operationCount(journal)).resolves.toBe(count)
    }
  })

  it('routes a terminal MCP cancel only after Skill absence and preserves MCP history', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-terminal-mcp-'))
    const store = createResourceControlStore({
      directory,
      scope,
      skills: { refresh: async () => [], reconcile: async () => [] },
      mcp: {
        reconcile: async ({ serverId }) => ({
          status: {
            serverId,
            connectionState: 'disabled',
            observedRevision: revision(definition),
            catalogRevision: null,
            toolCount: 0,
            observedAt: new Date().toISOString(),
          },
        }),
        reconnect: async ({ serverId }) => ({
          status: {
            serverId,
            connectionState: 'ready',
            observedRevision: revision(definition),
            catalogRevision: 'e'.repeat(64),
            toolCount: 0,
            observedAt: new Date().toISOString(),
          },
        }),
        test: async () => ({ toolCount: 0, catalogRevision: 'e'.repeat(64) }),
        tools: async ({ serverId }) => ({ serverId, catalogRevision: 'e'.repeat(64), items: [] }),
      },
    })
    const service = serviceFor(createResourceControlService(store))
    const created = (await service.call(
      '_agnes/v1/mcp.servers.create',
      { profile, definition, clientId: 'client', commandId: 'mcp-create' },
      authority,
    )) as ResourceOperationReceipt
    await settled(service, created.operationId)
    const journal = join(directory, 'mcp', `${profile}.mcp.json`)
    const count = await operationCount(journal)

    for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
      await terminalize(journal, created.operationId, state)
      const before = (await service.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: created.operationId },
        authority,
      )) as ResourceOperation
      await expect(
        service.call(
          '_agnes/v1/resources.operation.cancel',
          {
            profile,
            operationId: created.operationId,
            clientId: 'client',
            commandId: `mcp-terminal-${state}`,
          },
          authority,
        ),
      ).rejects.toMatchObject({ data: { code: 'RESOURCE_OPERATION_TERMINAL' } })
      await expect(
        service.call(
          '_agnes/v1/resources.operation.get',
          { profile, operationId: created.operationId },
          authority,
        ),
      ).resolves.toEqual(before)
      await expect(operationCount(journal)).resolves.toBe(count)
    }
  })
})
