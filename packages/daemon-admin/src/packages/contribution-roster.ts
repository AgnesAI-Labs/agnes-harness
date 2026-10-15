import { randomUUID } from 'node:crypto'
import type { InstalledInventory, InstalledPackage } from '@agnes/package-manager'
import {
  type ClientContribution,
  type ClientModuleListResult,
  type ClientModuleRosterRow,
  jcs,
} from '@agnes/protocol'

type Activations = Readonly<Record<string, { identity: string; id: string; active: boolean }>>
export function reconcileContributionActivations(
  previousActivations: Activations | undefined,
  packages: InstalledInventory['packages'],
): Activations {
  const activations = { ...previousActivations }
  for (const row of packages) {
    const active = row.enabled && row.trusted && row.blockers.length === 0
    const identity = jcs({ integrity: row.entry.integrity, capabilityHash: row.capabilityHash })
    const previous = activations[row.id]
    activations[row.id] = {
      identity,
      active,
      id: previous?.active && active && previous.identity === identity ? previous.id : randomUUID(),
    }
  }
  for (const packageId of Object.keys(activations))
    if (!packages.some((row) => row.id === packageId)) delete activations[packageId]
  return activations
}
export function contributionProjection(
  row: InstalledPackage,
  client: ClientContribution,
  owner: string,
  integrity: string,
  profileId: string,
  activationId: string | undefined,
): Partial<ClientModuleRosterRow> {
  return {
    ...(row.entry.metadata?.category === 'example' && row.entry.metadata.exampleOf
      ? { exampleOf: row.entry.metadata.exampleOf }
      : {}),
    ...(row.entry.metadata?.pageEntry ? { pageEntry: row.entry.metadata.pageEntry } : {}),
    binding: {
      lifetime: client.lifetime ?? 'session',
      owner,
      packageId: row.id,
      integrity,
      profileId,
      activationId: activationId ?? integrity,
      availability: 'active',
    },
    ...(client.homeEntries ? { homeEntries: client.homeEntries } : {}),
    ...(client.examplePages ? { examplePages: client.examplePages } : {}),
  }
}
export function combineContributionRosters(
  current: ClientModuleListResult,
  selected: ClientModuleListResult,
): ClientModuleListResult {
  const rows = [
    ...(current.rows ?? []).filter((row) => row.binding?.lifetime === 'profile'),
    ...(selected.rows ?? [])
      .filter(
        (row) =>
          row.binding?.lifetime !== 'profile' &&
          !(current.rows ?? []).some(
            (active) => active.rowId === row.rowId && active.binding?.lifetime === 'profile',
          ),
      )
      .map((row) => {
        const active = current.rows?.find(
          (candidate) => candidate.rowId === row.rowId && candidate.enabled && candidate.phase === 'ready',
        )
        return {
          ...row,
          ...(row.binding
            ? {
                binding: {
                  ...row.binding,
                  availability: active ? ('active' as const) : ('history-only' as const),
                },
              }
            : {}),
        }
      }),
  ]
  const modules = [
    ...current.modules.filter((module) =>
      rows.some(
        (row) =>
          row.binding?.lifetime === 'profile' &&
          row.packageId === module.packageId &&
          row.entryUrl === module.entryUrl,
      ),
    ),
    ...selected.modules.filter((module) =>
      rows.some(
        (row) =>
          row.binding?.lifetime !== 'profile' &&
          row.packageId === module.packageId &&
          row.entryUrl === module.entryUrl,
      ),
    ),
  ]
  const rowAliases = Object.fromEntries(
    Object.entries({ ...selected.rowAliases, ...current.rowAliases }).filter(
      ([source, target]) =>
        !rows.some((row) => row.rowId === source) && rows.some((row) => row.rowId === target),
    ),
  )
  const result = {
    ...current,
    rows,
    modules,
    rowAliases,
    statuses: [...current.statuses, ...selected.statuses],
  }
  return result
}

/** Reviewed client declarations retained with an immutable asset snapshot and reprojected on restore. */
export function clientContributionDeclarations(
  client: {
    [K in 'lifetime' | 'homeEntries' | 'examplePages' | 'assets' | 'streams']?:
      | ClientContribution[K]
      | undefined
  },
) {
  return {
    ...(client.lifetime ? { lifetime: client.lifetime } : {}),
    ...(client.homeEntries ? { homeEntries: client.homeEntries } : {}),
    ...(client.examplePages ? { examplePages: client.examplePages } : {}),
    ...(client.assets ? { assets: client.assets } : {}),
    ...(client.streams ? { streams: [...client.streams] } : {}),
  }
}
