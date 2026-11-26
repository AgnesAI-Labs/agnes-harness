import { randomUUID } from 'node:crypto'
import type { InstalledInventory, InstalledPackage } from '@agnes/package-manager'
import {
  type ClientContribution,
  type ClientModuleListResult,
  type ClientModuleRosterRow,
  jcs,
} from '@agnes/protocol'

import type { PresentationGrant } from './client-admission.js'
import { clientRoleBindings } from './role-selection.js'

export type ClientRegistryPackage = Pick<
  InstalledPackage,
  'id' | 'enabled' | 'trusted' | 'blockers' | 'directory' | 'capabilityHash' | 'contributions'
> & {
  entry: Pick<
    InstalledPackage['entry'],
    'integrity' | 'version' | 'previous' | 'declaredCapabilities' | 'metadata'
  >
}

type Activations = Readonly<Record<string, { identity: string; id: string; active: boolean }>>
export function reconcileContributionActivations(
  previousActivations: Activations | undefined,
  packages: readonly ClientRegistryPackage[],
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
  row: Pick<ClientRegistryPackage, 'id' | 'entry'>,
  client: ClientContribution,
  owner: string,
  integrity: string,
  context: { profile: string; inventory?: InstalledInventory },
  activationId: string | undefined,
  moduleName = owner,
  grants?: readonly PresentationGrant[],
  choices: readonly PresentationGrant[] = [],
): Promise<Partial<ClientModuleRosterRow>> {
  const roles = grants ? [...new Set(grants.flatMap((grant) => grant.roles))] : client.presentationRoles
  const pages = grants && new Set(grants.flatMap((grant) => grant.pages))
  const installed = roles?.length
    ? context.inventory?.packages.find((candidate) => candidate.id === row.id)
    : undefined
  const presentationRoleBindings =
    roles?.length && row.entry.integrity === integrity && installed && context.inventory
      ? await clientRoleBindings(
          context.inventory.packages,
          context.profile,
          installed,
          client,
          integrity,
          client.id ?? moduleName,
          roles,
        )
      : undefined
  if (presentationRoleBindings && row.entry.integrity === integrity) {
    for (const choice of choices) {
      if (
        choice.roleChoice &&
        choice.rowId === owner &&
        choice.packageId === row.id &&
        choice.clientId === (client.id ?? moduleName)
      ) {
        for (const role of choice.roles)
          if (roles?.includes(role)) presentationRoleBindings[role] = choice.consent
      }
    }
  }
  return {
    ...(!pages || (row.entry.metadata?.pageEntry !== undefined && pages.has(row.entry.metadata.pageEntry))
      ? {
          ...(row.entry.metadata?.exampleOf ? { exampleOf: row.entry.metadata.exampleOf } : {}),
          ...(row.entry.metadata?.pageEntry ? { pageEntry: row.entry.metadata.pageEntry } : {}),
        }
      : {}),
    clientId: client.id ?? moduleName,
    ...(presentationRoleBindings ? { presentationRoleBindings } : {}),
    ...(roles ? { presentationRoles: roles } : {}),
    binding: {
      lifetime: client.lifetime ?? 'session',
      owner,
      packageId: row.id,
      integrity,
      profileId: context.profile,
      activationId: activationId ?? integrity,
      availability: 'active',
    },
    ...(client.homeEntries
      ? { homeEntries: client.homeEntries.filter((page) => !pages || pages.has(page.id)) }
      : {}),
    ...(client.examplePages
      ? { examplePages: client.examplePages.filter((page) => !pages || pages.has(page)) }
      : {}),
  }
}

export function historicalContribution(row: ClientModuleRosterRow): boolean {
  return row.rendererDataUrl !== undefined || row.binding?.lifetime === 'session'
}

export function modulesForContributionRows(
  modules: ClientModuleListResult['modules'],
  rows: readonly ClientModuleRosterRow[],
): ClientModuleListResult['modules'] {
  return modules.filter((module) => {
    const rowId = module.rowId ?? `web:${module.packageId}`
    return rows.some(
      (row) => row.rowId === rowId && row.packageId === module.packageId && row.revision === module.revision,
    )
  })
}

export function combineContributionRosters(
  current: ClientModuleListResult,
  selected: ClientModuleListResult,
): ClientModuleListResult {
  const profileRows = (current.rows ?? []).filter(
    (row) => row.binding?.lifetime === 'profile' && !row.rendererDataUrl,
  )
  const historicalRows = (selected.rows ?? [])
    .filter((row) => historicalContribution(row) && !profileRows.some((active) => active.rowId === row.rowId))
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
    })
  const rows = [...profileRows, ...historicalRows]
  const modules = [
    ...modulesForContributionRows(current.modules, profileRows),
    ...modulesForContributionRows(selected.modules, historicalRows),
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
