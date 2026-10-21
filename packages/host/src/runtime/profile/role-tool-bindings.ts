import { canonicalJson, type RegisteredTool, sha256Hex } from '@agnes/core'
import { pluginConfigDigest } from '@agnes/plugin-runtime/host'
import type { Host } from '../lifecycle/host.js'

/** Prove the registration still describes the verified row configuration in this Host. */
export function roleToolBindingIdentity(host: Host, tool: RegisteredTool): string | undefined {
  const binding = tool.executionBinding
  if (
    !binding ||
    !tool.packageIdentity ||
    !tool.packageVersion ||
    ![binding.rowId, binding.exportName, binding.snapshotId].every(
      (value) => typeof value === 'string' && value.length > 0,
    ) ||
    !/^[0-9a-f]{64}$/.test(binding.configDigest)
  )
    return undefined
  const target = host.runtimeTargetSnapshot?.()
  const rows = target
    ? [...target.tree.rows, ...Object.values(target.resource.rows).filter((row) => row !== null)]
    : host.extensionRows.current()
  const row = rows.find((row) => row.id === binding.rowId && !row.disabled)
  if (
    !row ||
    binding.configDigest !==
      pluginConfigDigest(tool.source.trust === 'builtin' ? (row.config ?? {}) : row.config)
  )
    return undefined
  return sha256Hex(canonicalJson([tool.packageIdentity, tool.packageVersion, binding]))
}
