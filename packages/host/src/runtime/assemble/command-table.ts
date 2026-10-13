import { type PolicyRule, readCommandRules, withCommandFloorRegistry } from '@agnes/core/command-table'
import type { ToolPolicy, ToolPolicyCatalogEntry, ToolPolicyRegistryPort } from '@agnes/extension-api'
import { toolPolicyKind } from '@agnes/extension-api'
import { HostError } from '@agnes/host-common/errors'
import type { PresetDoc } from '@agnes/host-common/presets/types'

/**
 * The deployment's command table, read once at assembly from the default preset. A table that
 * cannot be read stops assembly with the rule named; it never degrades to deny-all at run time.
 */
export function readCommandTable(preset: PresetDoc) {
  try {
    return readCommandRules((preset.approval as { command_policy?: unknown } | undefined)?.command_policy)
  } catch (e) {
    throw new HostError('E_PRESET_UNSUPPORTED', (e as Error).message, {
      detail: { capability: 'approval.command_policy' },
    })
  }
}

/**
 * The registry the Kernel resolves tool policies from. The command table is a deployment floor
 * around whichever policy a session selects, third-party ones included.
 */
export function floorToolPolicies(
  providers: {
    registerHost(kind: typeof toolPolicyKind, source: string, policy: ToolPolicy): () => Promise<void>
    resolve(kind: typeof toolPolicyKind, id: string): ToolPolicy
  },
  catalog: () => readonly ToolPolicyCatalogEntry[],
  rules: readonly PolicyRule[],
): ToolPolicyRegistryPort {
  return withCommandFloorRegistry(
    {
      register: (source, policy) => providers.registerHost(toolPolicyKind, source, policy),
      resolve: (id) => providers.resolve(toolPolicyKind, id),
      catalog,
    },
    rules,
  )
}
