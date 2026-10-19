import { createHash } from 'node:crypto'
import type { InstalledPackage } from '@agnes/package-manager'
import {
  type ApplicationPreview,
  type ApplicationRoleTarget,
  type ApplicationTemplate,
  jcs,
  type PresentationRole,
  type PresentationRoleSelections,
  type PresentationRoleState,
  rpcError,
  validatePackageAdminData,
} from '@agnes/protocol'
import { applicationDependencies } from './application-dependencies.js'

export const roleDigest = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
const refuse = (reason: string): never => {
  throw rpcError('SEMANTIC_REJECTED', { reason })
}
const eligible = (p: InstalledPackage) => p.enabled && p.trusted && !p.blockers.length && !!p.directory
const parts = {
  navigation: ['primary-navigation'],
  conversation: ['conversation-transcript'],
  composer: ['message-composer'],
  goal: ['goal-summary', 'goal-workbench'],
  interaction: ['interaction-cards', 'interaction-workbench'],
  deliverables: ['deliverable-cards', 'deliverables-workbench'],
} satisfies Record<PresentationRole, string[]>
export const standardRoles = Object.keys(parts) as PresentationRole[]
type Active = (profile: string, id: string, integrity: string) => Promise<boolean>

function descriptor(
  packages: readonly InstalledPackage[],
  role: PresentationRole,
  target: ApplicationRoleTarget,
) {
  const p = packages.find((p) => p.id === target.packageId)
  const clients =
    p?.contributions.flatMap((c) =>
      'client' in c &&
      c.client?.lifetime === 'profile' &&
      (c.client.id ?? c.id) === target.clientId &&
      c.client.presentationRoles?.includes(role)
        ? [c.client]
        : [],
    ) ?? []
  const client = clients[0]
  if (!p || !client || clients.length !== 1) return refuse('APPLICATION_ROLE_UNDECLARED')
  return { p, client }
}

/** Uses only inventory declarations; previewing a role never imports its code. */
export async function previewRole(
  packages: readonly InstalledPackage[],
  profile: string,
  role: PresentationRole,
  target: ApplicationRoleTarget,
  active?: Active,
): Promise<ApplicationPreview> {
  if (!standardRoles.includes(role)) return refuse('APPLICATION_ROLE_UNDECLARED')
  const binding = { packageId: target.packageId, clientId: target.clientId }
  const { p, client } = descriptor(packages, role, binding)
  if (!eligible(p) || !active || !(await active(profile, p.id, p.entry.integrity)))
    return refuse('APPLICATION_ROLE_UNAVAILABLE')
  const required = new Map<string, InstalledPackage>()
  const visit = async (p: InstalledPackage): Promise<void> => {
    if (required.has(p.id)) return
    if (!eligible(p)) return refuse('APPLICATION_DEPENDENCY_UNAVAILABLE')
    required.set(p.id, p)
    for (const id of await applicationDependencies(p, packages)) {
      const dependency = packages.find((p) => p.id === id)
      if (!dependency) return refuse('APPLICATION_DEPENDENCY_MISSING')
      await visit(dependency)
    }
  }
  await visit(p)
  const source = validatePackageAdminData('PackageSource', p.entry.source)
  if (!source.ok) return refuse('APPLICATION_SOURCE_INVALID')
  const declaration: ApplicationTemplate = {
    id: 'role-selection',
    presentation: { roles: { [role]: binding } },
  }
  const body = {
    packageId: p.id,
    version: p.entry.version,
    integrity: p.entry.integrity,
    source: source.value as ApplicationPreview['source'],
    signature: p.entry.provenance?.verification ?? 'unverified',
    declaration,
    declarationDigest: roleDigest(client),
    assets: {},
    dependencies: [...required.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => ({
        packageId: p.id,
        version: p.entry.version,
        integrity: p.entry.integrity,
        capabilityHash: p.capabilityHash,
        source: p.entry.source,
        capabilities: p.entry.declaredCapabilities ?? [],
      })),
    replacedRoles: [
      {
        role,
        ...binding,
        entry: client.entry,
        integrity: p.entry.integrity,
        source: p.entry.source,
        visibleParts: parts[role],
      },
    ],
    dependencyDiff: { status: 'not-applicable' },
    scope: 'presentation-only-no-execution-change',
    recovery: '/?admin; agh app clear',
    warning: 'trusted-javascript-is-not-a-sandbox',
  }
  return { ...body, consentDigest: roleDigest(body) }
}

export async function roleStates(
  packages: readonly InstalledPackage[],
  profile: string,
  selections: PresentationRoleSelections = {},
  application: ApplicationTemplate | null,
  active?: Active,
  inventoryUnavailable = false,
): Promise<PresentationRoleState[]> {
  return Promise.all(
    standardRoles.map(async (role): Promise<PresentationRoleState> => {
      const candidates: PresentationRoleState['candidates'] = []
      for (const p of packages) {
        if (!eligible(p)) continue
        for (const c of p.contributions) {
          if ('client' in c && c.client?.lifetime === 'profile' && c.client.presentationRoles?.includes(role))
            candidates.push({ packageId: p.id, clientId: c.client.id ?? c.id, version: p.entry.version })
        }
      }
      const selection = selections[role] ?? null
      const base: PresentationRoleState = {
        role,
        selection,
        status: selection ? 'unresolved' : 'resolved',
        source: application?.presentation?.roles?.[role] ? 'application' : 'default',
        effective: application?.presentation?.roles?.[role] ?? null,
        candidates,
      }
      if (!selection) return base
      const p = packages.find((p) => p.id === selection.packageId)
      const reason = inventoryUnavailable
        ? 'inventory-unavailable'
        : !p
          ? 'removed'
          : !p.trusted
            ? 'untrusted'
            : !p.enabled
              ? 'disabled'
              : p.entry.integrity !== selection.integrity
                ? 'package-changed'
                : undefined
      if (reason) return { ...base, reason }
      try {
        const preview = await previewRole(packages, profile, role, selection, active)
        if (preview.declarationDigest !== selection.declarationDigest)
          return { ...base, reason: 'declaration-changed' }
        if (
          preview.consentDigest !== selection.consentDigest ||
          roleDigest(preview) !== selection.bindingDigest
        )
          return { ...base, reason: 'consent-changed' }
        return {
          ...base,
          status: 'resolved',
          source: 'choice',
          effective: { packageId: selection.packageId, clientId: selection.clientId },
        }
      } catch {
        return { ...base, reason: 'code-or-references-unavailable' }
      }
    }),
  )
}

/** Attests the roster's actual immutable declaration, never a name-only installed candidate. */
export async function clientRoleBindings(
  packages: readonly InstalledPackage[],
  profile: string,
  row: InstalledPackage,
  client: import('@agnes/protocol').ClientContribution,
  integrity: string,
  clientId: string,
): Promise<Partial<Record<PresentationRole, string>>> {
  const bindings: Partial<Record<PresentationRole, string>> = {}
  if (integrity !== row.entry.integrity || client.lifetime !== 'profile') return bindings
  for (const role of client.presentationRoles ?? []) {
    try {
      const preview = await previewRole(
        packages,
        profile,
        role,
        { packageId: row.id, clientId },
        async () => true,
      )
      if (preview.declarationDigest === roleDigest(client)) bindings[role] = roleDigest(preview)
    } catch {
      // Ineligible, ambiguous or drifted declarations have no admission identity.
    }
  }
  return bindings
}
