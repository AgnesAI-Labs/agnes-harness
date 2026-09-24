import type { McpStatus, SkillDescriptor } from '@agnes/protocol'
import { validateResourceControlData } from '@agnes/protocol'

/** Immutable paths and policy copied into a spawned worker's private environment. */
export type ResourceWorkerBootstrapConfiguration = Readonly<{
  snapshotPath?: string
  skillLkgDirectory?: string
  packageSkillSnapshotPath?: string
  mcpPolicy?: Readonly<{
    localStartApprovals?: boolean
    allowedExecutables: readonly string[]
    allowLoopbackHttp: boolean
    localDaemon: boolean
  }>
}>

/** Resource-only switches for a service generation. They never select a user session. */
export type ResourceWorkerAcquireOptions = Readonly<{
  resourceControl?: boolean
  resourceMcpServerId?: string
  resourceTestServerId?: string
}>

export type ResourceWorkerReport = Readonly<{
  snapshotRevision: string
  skills: readonly SkillDescriptor[]
  mcp: readonly McpStatus[]
}>

export type ResourceWorkerObservation = Readonly<{
  workerKind: 'session' | 'service'
  report: ResourceWorkerReport
}>

/** Builds the complete private resource environment from daemon-owned paths and policy. */
export function resourceWorkerEnvironment(
  options: ResourceWorkerAcquireOptions,
  configuration: ResourceWorkerBootstrapConfiguration | undefined,
): NodeJS.ProcessEnv {
  return {
    ...(options.resourceControl ? { AGNES_RESOURCE_CONTROL: '1' } : {}),
    ...(options.resourceMcpServerId ? { AGNES_RESOURCE_MCP_SERVER: options.resourceMcpServerId } : {}),
    ...(options.resourceTestServerId ? { AGNES_RESOURCE_TEST_SERVER: options.resourceTestServerId } : {}),
    ...(configuration?.snapshotPath ? { AGNES_RESOURCE_SNAPSHOT: configuration.snapshotPath } : {}),
    ...(configuration?.skillLkgDirectory
      ? { AGNES_RESOURCE_SKILL_LKG_DIR: configuration.skillLkgDirectory }
      : {}),
    ...(configuration?.packageSkillSnapshotPath
      ? { AGNES_PACKAGE_SKILL_SNAPSHOT: configuration.packageSkillSnapshotPath }
      : {}),
    ...(configuration?.mcpPolicy
      ? { AGNES_RESOURCE_MCP_POLICY: JSON.stringify(configuration.mcpPolicy) }
      : {}),
  }
}

/** Rejects untrusted worker bootstrap data before it can affect durable resource state. */
export function resourceWorkerObservation(value: {
  workerKind?: unknown
  resources?: unknown
}): ResourceWorkerObservation | undefined {
  if (!value.resources) return undefined
  const resources = value.resources as Partial<ResourceWorkerReport>
  if (
    !/^[a-f0-9]{64}$/.test(String(resources.snapshotRevision)) ||
    (value.workerKind !== 'session' && value.workerKind !== 'service') ||
    !Array.isArray(resources.skills) ||
    !Array.isArray(resources.mcp) ||
    !resources.skills.every((skill) => validateResourceControlData('SkillDescriptor', skill).ok) ||
    !resources.mcp.every((status) => validateResourceControlData('McpStatus', status).ok)
  )
    return undefined
  return { workerKind: value.workerKind, report: resources as ResourceWorkerReport }
}
