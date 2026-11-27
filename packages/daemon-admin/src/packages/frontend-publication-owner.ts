import type { InstalledInventory, InstalledPackage } from '@agnes/package-manager'
import { type FrontendPublicationOwnerResult, REMOTE_FRONTEND_SERVICE, rpcError } from '@agnes/protocol'
import { admissionDigest, installedClientTree } from './client-admission.js'
import type { PackageActivationObservation } from './handler.js'

/** The launcher discovers one current backend owner, not a browser client or a service directory. */
export async function frontendPublicationOwner(input: {
  profile: string
  inventory(): Promise<InstalledInventory>
  actual(packageId: string): Promise<PackageActivationObservation | undefined>
  workerGeneration(): number | undefined
}): Promise<FrontendPublicationOwnerResult> {
  const inventory = await input.inventory()
  const generation = input.workerGeneration()
  let owner: FrontendPublicationOwnerResult['owner']
  let observedPackage: InstalledPackage | undefined
  for (const row of inventory.packages) {
    if (!row.enabled || !row.trusted || row.blockers.length) continue
    const tree = installedClientTree(row)
    if (!tree) continue
    const declared = row.contributions.filter(
      (item) =>
        (item.kind === 'extension' || item.kind === 'client') &&
        'client' in item &&
        item.client?.services?.includes(REMOTE_FRONTEND_SERVICE) &&
        (item.kind !== 'extension' || Object.keys(item.capabilities).some((key) => key !== 'ui')),
    )
    if (!declared.length) continue
    const actual = await input.actual(row.id)
    if (
      actual?.actual !== 'running' ||
      actual.actualIntegrity !== tree.integrity ||
      (actual.actualVersion !== undefined && actual.actualVersion !== tree.version)
    )
      continue
    for (const item of declared) {
      if (owner) throw rpcError('SEMANTIC_REJECTED', { reason: 'FRONTEND_PUBLICATION_OWNER_AMBIGUOUS' })
      owner = {
        extension: item.id,
        identity: admissionDigest([
          input.profile,
          tree.packageId,
          item.id,
          tree.source ?? null,
          tree.version,
          tree.integrity,
          tree.treeIntegrity,
          tree.capabilityHash,
          actual.actualVersion ?? null,
          generation ?? null,
          item,
        ]),
      }
      observedPackage = row
    }
  }
  if (!owner || !observedPackage) return {}
  const current = await input.inventory()
  const actual = await input.actual(observedPackage.id)
  if (
    current.hash !== inventory.hash ||
    current.profile !== input.profile ||
    actual?.actual !== 'running' ||
    actual.actualIntegrity !== observedPackage.entry.integrity ||
    (actual.actualVersion !== undefined && actual.actualVersion !== observedPackage.entry.version) ||
    generation !== input.workerGeneration()
  )
    return {}
  return { owner }
}
