import type { InstalledInventory, InstalledPackage } from '@agnes/package-manager'

function sameInstalled(left: InstalledInventory, right: InstalledInventory, row: InstalledPackage): boolean {
  const current = right.packages.find((candidate) => candidate.id === row.id)
  return (
    left.profile === right.profile &&
    current?.entry.integrity === row.entry.integrity &&
    current.directory === row.directory &&
    current.enabled === row.enabled &&
    current.trusted === row.trusted
  )
}

/** Validate every copy against one fresh inventory after all copies finish, before publication. */
export function createPublicationChecks(original: InstalledInventory) {
  const checks: { row: InstalledPackage; refuse(): Promise<void> }[] = []
  return {
    add(row: InstalledPackage, refuse: () => Promise<void>) {
      checks.push({ row, refuse })
    },
    async verify(refresh: () => Promise<InstalledInventory>) {
      if (!checks.length) return
      const current = await refresh()
      for (const check of checks) {
        if (!sameInstalled(original, current, check.row)) await check.refuse()
      }
    },
  }
}
