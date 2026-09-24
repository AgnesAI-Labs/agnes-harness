import type { RuntimeTarget } from '@agnes/plugin-runtime/host'
import type { HostBuiltinRowClaim } from './assemble/seams-cordis.js'

const isBuiltinPlugin = (plugin: string): boolean => plugin.startsWith('builtin:')

function claimKey(row: Readonly<{ id: string; mountIdentity: string }>): string {
  return `${row.id}\0${row.mountIdentity}`
}

/**
 * Host-private snapshot/claim authority for builtin, preset and seam rows.
 *
 * These rows are not third-party catalogue snapshots. A missing claim fails closed rather than
 * synthesizing a fake package@snapshot identity.
 */
export function resolveRuntimeTargetBuiltinClaims(
  target: RuntimeTarget,
  hostClaims: readonly Readonly<HostBuiltinRowClaim>[],
  snapshotClaims: readonly Readonly<HostBuiltinRowClaim>[] = [],
): readonly Readonly<HostBuiltinRowClaim>[] {
  const byRow = new Map<string, Readonly<HostBuiltinRowClaim>>()
  for (const claim of hostClaims) byRow.set(claim.row.id, claim)
  for (const claim of snapshotClaims) byRow.set(claim.row.id, claim)

  const selected = new Map<string, Readonly<HostBuiltinRowClaim>>()
  for (const row of target.tree.rows) {
    if (!isBuiltinPlugin(row.plugin)) continue
    const claim = byRow.get(row.id)
    if (!claim || claimKey(claim.row) !== claimKey(row)) {
      throw new Error(`E_RUNTIME_TARGET_STATIC_CLAIM: missing Host-private claim for ${row.id}`)
    }
    selected.set(row.id, claim)
  }

  // An enabled package row under a Host ext: id replaces the builtin one, which then gets no claim.
  const replaced = (id: string) =>
    id.startsWith('ext:') && target.tree.rows.some((row) => row.id === id && !row.disabled)
  for (const claim of hostClaims) {
    if (!selected.has(claim.row.id) && isBuiltinPlugin(claim.row.plugin) && !replaced(claim.row.id))
      selected.set(claim.row.id, claim)
  }
  return Object.freeze([...selected.values()])
}
