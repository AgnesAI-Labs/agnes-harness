import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillInstallInvocation } from '@agnes/host'
import { mcpImportError } from '@agnes/package-manager'
import {
  jcs,
  type McpServerDefinitionInput,
  type ResourceControlMethodName,
  type ResourcePermission,
  type SkillImportResult,
} from '@agnes/protocol'
import type { ResourceControlService } from '@agnes/resource-control-store'
import type { PackageAdminAuthority } from './permissions.js'

export type ImportResult = SkillImportResult
export type McpPreview = NonNullable<ImportResult['mcp']>
export type McpPlan = {
  // Read-only compatibility for installations prepared by earlier local builds.
  runtime?: {
    ready: boolean
    attempts: string[]
    root?: string
    integrity?: string
  }
  metadata?: { name: string; version?: string; description?: string; installedAt?: string }
  uncertain?: boolean
  owner: string
  id: string
  root: string
  integrity: string
  expires: number
  result: ImportResult
  definitions: McpServerDefinitionInput[]
  skills: Map<string, { invocation: SkillInstallInvocation; proposalId: string }>
  running?: Promise<void>
  controller?: AbortController
}
export const importDigest = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
export const resourcePort = (
  resources: Pick<ResourceControlService, 'call'>,
  profile: string,
  granted: PackageAdminAuthority,
) => {
  const permissions: ResourcePermission[] = ['mcp.read', 'resources.read']
  if (granted.permissions.includes('packages.install'))
    permissions.push('mcp.manage', 'resources.skills.write', 'skills.refresh', 'resources.reconcile')
  if (granted.permissions.includes('packages.remove'))
    permissions.push(
      'mcp.manage',
      'mcp.activate',
      'resources.skills.write',
      'skills.refresh',
      'resources.reconcile',
    )
  if (granted.permissions.includes('packages.trust')) permissions.push('mcp.trust', 'skills.trust')
  if (granted.permissions.includes('packages.activate')) permissions.push('mcp.test', 'mcp.activate')
  if (granted.permissions.includes('credentials.read')) permissions.push('secrets.use')
  return (method: ResourceControlMethodName, data: Record<string, unknown>): Promise<unknown> =>
    resources.call(
      method,
      { ...data, profile, ...('commandId' in data ? { clientId: granted.clientId } : {}) },
      { audience: 'admin', principalId: granted.principalId, clientId: granted.clientId, permissions },
    )
}
export type ImportResourcePort = ReturnType<typeof resourcePort>
export async function checkMcpSourceBudget(root: string, signal: AbortSignal) {
  let entries = 0,
    bytes = 0
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 32) return mcpImportError('MCP_SOURCE_LIMIT')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal.throwIfAborted()
      if (++entries > 10000) return mcpImportError('MCP_SOURCE_LIMIT')
      const path = join(directory, entry.name),
        stat = await lstat(path)
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        return mcpImportError('MCP_PATH_INVALID')
      if (stat.isDirectory()) await walk(path, depth + 1)
      else {
        bytes += stat.size
        if (stat.nlink !== 1 || bytes > 128 * 1024 * 1024) return mcpImportError('MCP_SOURCE_LIMIT')
      }
    }
  }
  await walk(root, 0)
}
