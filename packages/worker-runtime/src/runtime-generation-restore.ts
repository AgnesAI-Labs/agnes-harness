import type { HostOptions } from '@agnes/host'
import { jcs, validateResourceControlData } from '@agnes/protocol'
import {
  createMcpServerOpener,
  deploymentMcpPolicy,
  type WorkerResourceBootstrapInput,
} from '@agnes/resource-control-worker'
import { mcpServerRowsFromDefinitions, type McpServerSnapshotEntry } from './mcp-server-rows.js'

/** Recreate factories from pinned definitions; resolve SecretRefs only when connecting. */
export function generationExtensionRestorer(
  input: WorkerResourceBootstrapInput,
): NonNullable<HostOptions['restoreGenerationExtension']> {
  return (metadata) => {
    if (metadata.kind !== 'mcp-server')
      throw new Error(`E_GENERATION_FACTORY_KIND: unsupported ${metadata.kind}`)
    const entry = metadata.data as unknown as McpServerSnapshotEntry
    if (
      !entry ||
      !validateResourceControlData('McpServerDefinitionInput', entry.definition).ok ||
      typeof entry.revision !== 'string' ||
      entry.trust !== 'trusted' ||
      entry.desired !== 'enabled'
    )
      throw new Error(
        'E_GENERATION_MCP_DEFINITION: pinned MCP definition is invalid or not enabled and trusted',
      )
    const policy = deploymentMcpPolicy(input.env)
    const opener = createMcpServerOpener({
      resolver: async (ref) => input.createSecrets(input.profile).resolve(ref),
      approvedLocalStart: (definition) =>
        Promise.resolve(policy.localStartApprovals === true && jcs(definition) === jcs(entry.definition)),
      baseEnv: {},
      stdioPolicy: { allowedExecutables: policy.allowedExecutables },
      httpPolicy: { allowLoopbackHttp: policy.allowLoopbackHttp, localDaemon: policy.localDaemon },
    })
    const { rows, skipped } = mcpServerRowsFromDefinitions([entry], opener)
    const row = rows[0]
    if (!row) throw new Error(`E_GENERATION_MCP_UNRESTORABLE: ${skipped[0]?.reason ?? 'factory unavailable'}`)
    return row
  }
}
