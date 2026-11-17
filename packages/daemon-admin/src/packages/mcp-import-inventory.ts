import { lstat, opendir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  type PackageListResult,
  type PackageSource,
  rpcError,
  validatePackageAdminCall,
} from '@agnes/protocol'
import type { ImportResourcePort, McpPlan } from './mcp-import-state.js'
import { summarizeMcpPackage } from './mcp-import-status.js'

type ExternalPackage = NonNullable<PackageListResult['externalPackages']>[number]

export function importPackageName(source: PackageSource): string {
  if (source.type === 'git') {
    try {
      const path = new URL(source.ref.replace(/^git:/, '').split('#')[0]!).pathname
      return (
        path
          .replace(/^\//, '')
          .replace(/\.git$/, '')
          .slice(0, 256) || 'MCP'
      )
    } catch {
      /* A reviewed non-URL source retains its bounded basename. */
    }
  }
  return basename(source.ref.replaceAll('\\', '/').split('#')[0]!).slice(0, 256) || 'MCP'
}

async function observe(
  port: ImportResourcePort,
  kind: 'mcp' | 'skill',
  resourceId: string,
  name: string,
  revision: string,
  removed: boolean,
): Promise<ExternalPackage['resources'][number]> {
  const row = { kind, resourceId, name }
  if (removed) return { ...row, state: 'removed' }
  try {
    const current = (await port('_agnes/v1/resources.get', { resourceId })) as {
      revision: string
      desired?: 'enabled' | 'disabled'
      actual?: string
      trust?: 'trusted' | 'untrusted' | 'rejected'
    }
    return {
      ...row,
      state: current.revision === revision ? 'present' : 'changed',
      ...(current.desired ? { desired: current.desired } : {}),
      ...(current.actual ? { actual: current.actual } : {}),
      ...(current.trust ? { trust: current.trust } : {}),
    }
  } catch (error) {
    const code = (error as { data?: { code?: string } }).data?.code
    return {
      ...row,
      state: code === 'RESOURCE_NOT_FOUND' || code === 'MCP_NOT_FOUND' ? 'missing' : 'unknown',
    }
  }
}

/** Receipts own package membership; resource governance owns live state and revision. */
export async function readMcpInventory(
  directory: string,
  owner: string,
  port: ImportResourcePort,
  active: ReadonlySet<string>,
) {
  let entries: Awaited<ReturnType<typeof opendir>>
  try {
    entries = await opendir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const packages: ExternalPackage[] = []
  let visited = 0
  for await (const entry of entries) {
    if (++visited > 8192) throw rpcError('SEMANTIC_REJECTED', { reason: 'MCP_PACKAGE_INVENTORY_LIMIT' })
    if (!entry.isFile() || !/^mcp-import-[a-f0-9-]{36}\.json$/.test(entry.name)) continue
    const path = join(directory, entry.name),
      stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) continue
    let stored: {
      owner?: unknown
      result?: McpPlan['result']
      metadata?: McpPlan['metadata']
      uncertain?: boolean
    }
    try {
      stored = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      continue
    }
    const result = stored.result
    if (
      stored.owner !== owner ||
      !result ||
      result.kind !== 'mcp' ||
      !result.mcp ||
      result.proposalId !== entry.name.slice(0, -5) ||
      !result.resolvedSource ||
      !validatePackageAdminCall('_agnes/v1/packages.skillImport', 'result', result).ok
    )
      continue
    if (['prepared', 'cancelled'].includes(result.state)) continue
    if (
      !stored.uncertain &&
      !result.mcp.servers.some((row) => row.revision) &&
      !result.mcp.skills.some((row) => row.resourceId)
    )
      continue
    const metadata = stored.metadata
    const item: ExternalPackage = {
      id: result.proposalId!,
      name: metadata?.name ?? importPackageName(result.resolvedSource),
      ...(metadata?.version ? { version: metadata.version } : {}),
      ...(metadata?.description ? { description: metadata.description } : {}),
      ...(metadata?.installedAt ? { installedAt: metadata.installedAt } : {}),
      source: result.resolvedSource,
      // Inventory carries package outcome and identity, not every command and environment probe
      // from the installation preview. Individual capabilities retain their own detail APIs.
      result: {
        kind: 'mcp',
        state: result.state,
        proposalId: result.proposalId,
        ...(result.digest ? { digest: result.digest } : {}),
        ...(result.sourceDigest ? { sourceDigest: result.sourceDigest } : {}),
        ...(result.phase ? { phase: result.phase } : {}),
        ...(result.message ? { message: result.message } : {}),
        ...(result.activation?.outcomes
          ? {
              activation: {
                digest: result.activation.digest,
                enable: result.activation.enable,
                expiresAt: result.activation.expiresAt,
                environment: [],
                issues: [],
                warnings: [],
                outcomes: result.activation.outcomes,
                resources: result.activation.resources.map(
                  ({ kind, resourceId, name, revision, desired, trust }) => ({
                    kind,
                    resourceId,
                    name,
                    revision,
                    desired,
                    trust,
                  }),
                ),
              },
            }
          : {}),
      },
      resources: [],
    }
    // A cold receipt is recovery evidence, never proof that an operation is still running.
    if (item.result.state === 'running' && !active.has(item.id))
      item.result = { ...item.result, state: 'interrupted', message: 'MCP_IMPORT_INTERRUPTED' }
    // Validate metadata before making resource queries or exposing any record.
    if (
      !validatePackageAdminCall('_agnes/v1/packages.list', 'result', {
        packages: [],
        externalPackages: [item],
      }).ok
    )
      continue
    for (const row of result.mcp.servers)
      if (row.revision)
        item.resources.push(
          await observe(
            port,
            'mcp',
            `mcp/${row.serverId}`,
            row.serverId,
            row.revision,
            row.state === 'removed',
          ),
        )
    for (const row of result.mcp.skills)
      if (row.resourceId && row.revision)
        item.resources.push(
          await observe(port, 'skill', row.resourceId, row.name, row.revision, row.state === 'removed'),
        )
    Object.assign(item, summarizeMcpPackage(item))
    packages.push(item)
    if (packages.length > 1024) throw rpcError('SEMANTIC_REJECTED', { reason: 'MCP_PACKAGE_INVENTORY_LIMIT' })
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}
