import { randomUUID } from 'node:crypto'
import type { createSkillInstaller, SkillInstallInvocation } from '@agnes/host'
import { mcpImportError } from '@agnes/package-manager'
import type { ResourceOperation, SkillImportParams } from '@agnes/protocol'
import { type ImportResourcePort, importDigest, type McpPlan } from './mcp-import-state.js'
export type ImportSkillPort = {
  request(
    invocation: SkillInstallInvocation,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<ReturnType<typeof createSkillInstaller>['request']>>>
}
const missingResource = (error: unknown) =>
  ['RESOURCE_NOT_FOUND', 'MCP_NOT_FOUND'].includes((error as { data?: { code?: string } }).data?.code ?? '')

export async function importResourceEffect(
  port: ImportResourcePort,
  method: Parameters<ImportResourcePort>[0],
  data: Record<string, unknown>,
  signal: AbortSignal,
  accepted?: () => Promise<void>,
) {
  signal.throwIfAborted()
  const receipt = (await port(method, data)) as { operationId: string }
  await accepted?.()
  const deadline = Date.now() + 90_000
  let operation: ResourceOperation
  do {
    signal.throwIfAborted()
    operation = (await port('_agnes/v1/resources.operation.get', {
      operationId: receipt.operationId,
    })) as ResourceOperation
    if (['succeeded', 'failed', 'cancelled'].includes(operation.state)) break
    if (Date.now() > deadline) return mcpImportError('MCP_OPERATION_TIMEOUT')
    await new Promise<void>((done) => setTimeout(done, 100))
  } while (!['succeeded', 'failed', 'cancelled'].includes(operation.state))
  if (operation.state !== 'succeeded')
    throw Object.assign(new Error('MCP_OPERATION_FAILED'), {
      code: 'MCP_OPERATION_FAILED',
      safeCode: operation.lastSafeError?.code,
    })
  return operation
}

export async function commitMcpPlan(
  plan: McpPlan,
  params: SkillImportParams,
  port: ImportResourcePort,
  skills: ImportSkillPort,
  save: () => Promise<void>,
  signal: AbortSignal,
) {
  const preview = plan.result.mcp!
  const effect = (method: Parameters<ImportResourcePort>[0], data: Record<string, unknown>) =>
    importResourceEffect(port, method, { ...data, commandId: `${plan.id}-${randomUUID()}` }, signal)
  for (let i = 0; i < plan.definitions.length; i++) {
    signal.throwIfAborted()
    const definition = plan.definitions[i]!,
      row = preview.servers[i]!
    if (row.state !== 'planned') continue
    if (!row.selected) {
      row.state = 'not-installed'
      continue
    }
    plan.uncertain = true
    await save()
    await importResourceEffect(
      port,
      '_agnes/v1/mcp.servers.create',
      { definition, commandId: `${plan.id}-${randomUUID()}` },
      signal,
      async () => {
        row.revision = importDigest(definition)
        row.state = 'registered'
        delete plan.uncertain
        await save()
      },
    )
  }
  for (const path of params.skillDirectories ?? []) {
    const entry = plan.skills.get(path),
      row = preview.skills.find((skill) => skill.path === path)
    if (!entry || !row || row.state !== 'prepared') return mcpImportError('MCP_SKILL_UNAVAILABLE')
    plan.uncertain = true
    await save()
    let result = await skills.request(
      { ...entry.invocation, input: { action: 'commit', proposalId: entry.proposalId } },
      signal,
    )
    while (result.state === 'running') {
      signal.throwIfAborted()
      await new Promise((done) => setTimeout(done, 100))
      result = await skills.request(
        { ...entry.invocation, input: { action: 'status', proposalId: entry.proposalId } },
        signal,
      )
    }
    if (result.state !== 'installed' || !result.resourceId || !result.revision)
      return mcpImportError('MCP_SKILL_INSTALL_FAILED')
    row.state = 'installed'
    delete plan.uncertain
    row.resourceId = result.resourceId
    row.revision = result.revision
    await save()
  }
  if (params.testConnection)
    for (const row of preview.servers) {
      if (!row.selected) continue
      if (!row.revision) return mcpImportError('MCP_RESOURCE_CONFLICT')
      plan.result.phase = 'testing'
      await save()
      await effect('_agnes/v1/mcp.servers.trust.set', {
        serverId: row.serverId,
        expectedRevision: row.revision,
        trust: 'trusted',
      })
      let tested: ResourceOperation
      try {
        tested = await effect('_agnes/v1/mcp.servers.test', {
          serverId: row.serverId,
          expectedRevision: row.revision,
        })
      } catch (error) {
        row.state = 'failed'
        const code = (error as { safeCode?: string }).safeCode
        if (code && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)) row.errorCode = code
        await save()
        throw error
      }
      row.state = 'tested'
      row.toolCount = tested.result?.toolCount ?? 0
      await save()
    }
}

export async function rollbackMcpPlan(
  plan: McpPlan,
  port: ImportResourcePort,
  save: () => Promise<void>,
  signal: AbortSignal,
) {
  const effect = (method: Parameters<ImportResourcePort>[0], data: Record<string, unknown>) =>
    importResourceEffect(port, method, { ...data, commandId: `${plan.id}-${randomUUID()}` }, signal)
  for (const row of plan.result.mcp!.skills.filter((skill) => skill.state === 'installed')) {
    if (!row.resourceId || !row.revision) return mcpImportError('MCP_RESOURCE_CONFLICT')
    try {
      const current = (await port('_agnes/v1/resources.get', { resourceId: row.resourceId })) as {
        revision: string
      }
      if (current.revision !== row.revision) return mcpImportError('MCP_RESOURCE_CONFLICT')
    } catch (error) {
      if (!missingResource(error)) throw error
      row.state = 'removed'
      await save()
      continue
    }
    await effect('_agnes/v1/skills.remove', { resourceId: row.resourceId, expectedRevision: row.revision })
    row.state = 'removed'
    await save()
  }
  for (const row of [...plan.result.mcp!.servers].reverse()) {
    if (!row.revision || row.state === 'removed' || row.state === 'planned') continue
    let current: {
      revision: string
      desired: string
    }
    try {
      current = (await port('_agnes/v1/mcp.servers.get', { serverId: row.serverId })) as typeof current
    } catch (error) {
      if (!missingResource(error)) throw error
      row.state = 'removed'
      await save()
      continue
    }
    if (current.revision !== row.revision) return mcpImportError('MCP_RESOURCE_CONFLICT')
    if (current.desired === 'enabled')
      await effect('_agnes/v1/mcp.servers.disable', {
        serverId: row.serverId,
        expectedRevision: row.revision,
      })
    await effect('_agnes/v1/mcp.servers.remove', { serverId: row.serverId, expectedRevision: row.revision })
    row.state = 'removed'
    delete row.errorCode
    delete row.toolCount
    await save()
  }
}
