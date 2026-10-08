import type { McpServerOpener } from '@agnes/base'
import type { HostOptions } from '@agnes/host'
import { jcs, validateResourceControlData } from '@agnes/protocol'
import {
  createMcpServerOpener,
  deploymentMcpPolicy,
  type WorkerResourceBootstrapInput,
} from '@agnes/resource-control-worker'
import { FIRST_ATTEMPT_TIMEOUT_MS, settledWithin } from './mcp-row-runtime.js'
import { type McpServerSnapshotEntry, mcpServerRowsFromDefinitions } from './mcp-server-rows.js'

/** Recreate current resource factories for cold code generations; resolve SecretRefs only when connecting. */
export function generationExtensionRestorer(
  input: WorkerResourceBootstrapInput,
  sharedOpener?: McpServerOpener,
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
      throw new Error('E_GENERATION_MCP_DEFINITION: MCP definition is invalid or not enabled and trusted')
    const policy = deploymentMcpPolicy(input.env)
    const opener =
      sharedOpener ??
      createMcpServerOpener({
        resolver: async (ref) => input.createSecrets(input.profile).resolve(ref),
        approvedLocalStart: (definition) =>
          Promise.resolve(policy.localStartApprovals === true && jcs(definition) === jcs(entry.definition)),
        sandbox: {
          dataDir: input.profile.dataDir,
          ...(input.cwd ? { workspace: input.cwd } : {}),
          ...(input.env.PATH ? { path: input.env.PATH } : {}),
        },
        baseEnv: {},
        stdioPolicy: { allowedExecutables: policy.allowedExecutables },
        httpPolicy: { allowLoopbackHttp: policy.allowLoopbackHttp, localDaemon: policy.localDaemon },
      })
    const { rows, skipped } = mcpServerRowsFromDefinitions([entry], opener)
    const row = rows[0]
    if (!row) throw new Error(`E_GENERATION_MCP_UNRESTORABLE: ${skipped[0]?.reason ?? 'factory unavailable'}`)
    return {
      ...row,
      async factory(ctx) {
        let firstAttempt: Promise<unknown> | undefined
        const restored = mcpServerRowsFromDefinitions([entry], opener, {
          onFirstAttempt: (_serverId, ready) => {
            firstAttempt = ready
          },
        }).rows[0]
        const activate = await restored?.factory(ctx)
        if (!activate) throw new Error('E_GENERATION_MCP_UNRESTORABLE: factory unavailable')
        return async (api) => {
          const dispose = await activate(api)
          // Cold sessions capture their tool registry after activation. Complete the first catalog
          // sync (or its bounded failure) before that capture, as the ordinary MCP apply path does.
          await settledWithin(firstAttempt ? [firstAttempt] : [], FIRST_ATTEMPT_TIMEOUT_MS, ctx.signal)
          return dispose
        }
      },
    }
  }
}
