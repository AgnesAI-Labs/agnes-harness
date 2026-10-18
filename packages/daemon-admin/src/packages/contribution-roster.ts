import { randomUUID } from 'node:crypto'
import type { InstalledInventory, InstalledPackage } from '@agnes/package-manager'
import {
  type ClientContribution,
  type ClientModuleListResult,
  type ClientModuleRosterRow,
  jcs,
} from '@agnes/protocol'

import { clientRoleBindings } from './role-selection.js'

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
export async function contributionProjection(
  row: InstalledPackage,
  client: ClientContribution,
  owner: string,
  integrity: string,
  context: { profile: string; inventory: InstalledInventory },
  activationId: string | undefined,
): Promise<Partial<ClientModuleRosterRow>> {
  return {
    ...(row.entry.metadata?.exampleOf ? { exampleOf: row.entry.metadata.exampleOf } : {}),
    ...(row.entry.metadata?.pageEntry ? { pageEntry: row.entry.metadata.pageEntry } : {}),
    clientId: client.id ?? owner,
    ...(client.presentationRoles?.length
      ? {
          presentationRoleBindings: await clientRoleBindings(
            context.inventory.packages,
            context.profile,
            row,
            client,
            integrity,
            client.id ?? owner,
          ),
        }
      : {}),
    ...(client.presentationRoles ? { presentationRoles: client.presentationRoles } : {}),
    binding: {
      lifetime: client.lifetime ?? 'session',
      owner,
      packageId: row.id,
      integrity,
      profileId: context.profile,
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
    [K in
      | 'id'
      | 'presentationRoles'
      | 'requiresBackendRows'
      | 'lifetime'
      | 'homeEntries'
      | 'examplePages'
      | 'assets'
      | 'streams']?: ClientContribution[K] | undefined
  },
) {
  return {
    ...(client.id ? { id: client.id } : {}),
    ...(client.presentationRoles ? { presentationRoles: client.presentationRoles } : {}),
    ...(client.requiresBackendRows ? { requiresBackendRows: [...client.requiresBackendRows] } : {}),
    ...(client.lifetime ? { lifetime: client.lifetime } : {}),
    ...(client.homeEntries ? { homeEntries: client.homeEntries } : {}),
    ...(client.examplePages ? { examplePages: client.examplePages } : {}),
    ...(client.assets ? { assets: client.assets } : {}),
    ...(client.streams ? { streams: [...client.streams] } : {}),
  }
}
