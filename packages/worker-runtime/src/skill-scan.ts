import type { SkillDescriptor, SkillRootStatus } from '@agnes/protocol'
import {
  bootstrapWorkerResources,
  type WorkerResourceBootstrapInput,
  type WorkerResourceState,
} from '@agnes/resource-control-worker'

/** Observe a throwaway workspace generation without mounting MCP or changing active sessions.
 * The snapshot digest fences observations against the daemon's durable control decisions. */
async function buildWorkspaceSkillScan(
  workerResourcesInput: WorkerResourceBootstrapInput,
  workspaceRoot: string,
  skillResourceIds?: readonly string[],
): Promise<WorkerResourceState> {
  const temp = await bootstrapWorkerResources({
    ...workerResourcesInput,
    cwd: workspaceRoot,
    mcpRows: true,
    ...(skillResourceIds ? { skillResourceIds } : {}),
  })
  if (!temp) throw new Error('resource worker did not observe a snapshot for this workspace scan')
  return temp
}

export async function scanWorkspaceSkills(
  workerResourcesInput: WorkerResourceBootstrapInput,
  params: {
    workspaceRoot: string
    rootKey?: string
    snapshotRevision: string
    resourceIds?: readonly string[]
  },
): Promise<{
  /** The resolved descriptors (actual/trust/desired/resolution), for reconcile's re-observation of
   *  Skills the daemon already tracks. Never filtered by `rootKey` (reconcile never passes one). */
  skills: readonly SkillDescriptor[]
  /** Raw candidates + capability hash, for refresh's discovery of new/changed Skills. */
  candidates: readonly Readonly<{ descriptor: SkillDescriptor; capabilityHash: string }>[]
  failedRoots: readonly string[]
  skippedResourceIds: readonly string[]
  roots: readonly SkillRootStatus[]
}> {
  const temp = await buildWorkspaceSkillScan(workerResourcesInput, params.workspaceRoot, params.resourceIds)
  try {
    if (temp.revision !== params.snapshotRevision)
      throw new Error('resource snapshot changed before this Skill scan completed')
    const rootKey = params.rootKey
    return {
      skills: temp.skills,
      candidates: rootKey
        ? temp.discovery.candidates.filter((row) => row.descriptor.sourceIdentity.rootKey === rootKey)
        : temp.discovery.candidates,
      failedRoots: temp.discovery.failedRoots,
      skippedResourceIds: rootKey
        ? temp.discovery.skippedResourceIds.filter((id) => id.split('/')[2] === rootKey)
        : temp.discovery.skippedResourceIds,
      roots: temp.discovery.roots,
    }
  } finally {
    await temp.runtime.mcp.close().catch(() => undefined)
  }
}

export async function removeWorkspaceSkill(
  workerResourcesInput: WorkerResourceBootstrapInput,
  params: { workspaceRoot: string; descriptor: SkillDescriptor; validateOnly: boolean },
): Promise<void> {
  const temp = await buildWorkspaceSkillScan(workerResourcesInput, params.workspaceRoot)
  try {
    await temp.removeSkill(params.descriptor, params.validateOnly)
  } finally {
    await temp.runtime.mcp.close().catch(() => undefined)
  }
}

export function skillScanSelection(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    !value.every((id) => typeof id === 'string' && /^skill\//.test(id))
  )
    throw new TypeError('invalid Skill observation selection')
  return value
}

export function scanWorkspaceSkillRequest(
  input: WorkerResourceBootstrapInput,
  p: {
    workspaceRoot?: unknown
    snapshotRevision?: unknown
    rootKey?: unknown
    resourceIds?: unknown
  },
) {
  if (typeof p.workspaceRoot !== 'string' || typeof p.snapshotRevision !== 'string')
    throw new TypeError('invalid Skill scan request')
  const resourceIds = skillScanSelection(p.resourceIds)
  return scanWorkspaceSkills(input, {
    workspaceRoot: p.workspaceRoot,
    snapshotRevision: p.snapshotRevision,
    ...(typeof p.rootKey === 'string' ? { rootKey: p.rootKey } : {}),
    ...(resourceIds ? { resourceIds } : {}),
  })
}
