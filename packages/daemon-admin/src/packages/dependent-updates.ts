import { satisfiesApiRange } from '@agnes/extension-api'
import type { InstalledInventory, PackageManager } from '@agnes/package-manager'
import type { PackageActivationRequest, PackageUpdateParams } from '@agnes/protocol'

type Updates = NonNullable<PackageUpdateParams['dependents']>
/** The outer RPC schema has validated the immutable operation payload. */
export function reviewedUpdateOptions(
  params: Record<string, unknown>,
): Pick<Parameters<PackageManager['update']>[3], 'activation' | 'dependents'> {
  const activation = params.activation as PackageActivationRequest | undefined
  return {
    ...(activation
      ? {
          activation: {
            expectedInstalledIntegrity: activation.expectedInstalledIntegrity,
            trust: activation.trust,
          },
        }
      : {}),
    ...(params.dependents ? { dependents: params.dependents as Updates } : {}),
  }
}
export async function assertDependentBaselines(
  params: Record<string, unknown>,
  check: (params: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  if (params.dependents === undefined) return
  if (!params.activation) throw { code: 'E_PACKAGE_STATE' }
  for (const dependent of params.dependents as Updates) {
    if (dependent.activation.trust.integrity !== dependent.expectedIntegrity)
      throw { code: 'E_PACKAGE_PREVIEW_STALE' }
    await check({ id: dependent.id, ...dependent.activation })
  }
}
export function dependentUpdatesApplied(
  params: Record<string, unknown>,
  inventory: InstalledInventory,
): boolean {
  if (!params.dependents) return true
  const candidates = params.dependents as Updates
  const parent = inventory.packages.find((pkg) => pkg.id === params.id)
  if (
    !parent ||
    new Set([parent.id, ...candidates.map((candidate) => candidate.id)]).size !== candidates.length + 1
  )
    return false
  return candidates.every((candidate) =>
    inventory.packages.some(
      (pkg) =>
        pkg.id === candidate.id &&
        pkg.entry.integrity === candidate.expectedIntegrity &&
        pkg.trusted &&
        !pkg.blockers.length &&
        Object.hasOwn(pkg.entry.dependencies, parent.id) &&
        satisfiesApiRange(pkg.entry.dependencies[parent.id] ?? '', parent.entry.version) &&
        pkg.capabilityHash === candidate.activation.trust.capabilityHash,
    ),
  )
}
