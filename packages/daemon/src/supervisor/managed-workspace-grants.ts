import { isAbsolute, resolve } from 'node:path'
import {
  type PackageAdminAuthorityResolver,
  requireLocalAdminAuthority,
} from '@agnes/daemon-admin/packages/index'
import type { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { type MethodName, rpcError } from '@agnes/protocol'
import type {
  ManagedWorkspaceGrantChange,
  ManagedWorkspaceGrantParams,
  ManagedWorkspaceGrantsList,
  ManagedWorkspaceGrantsListParams,
} from '@agnes/protocol/gen/app-server'
import { grantKey, type ManagedSessionRecords } from './managed-session-records.js'
import type { ManagedSessionPackage } from './profile-services.js'

export interface ManagedWorkspaceGrantPorts {
  records: Pick<
    ManagedSessionRecords,
    'grants' | 'granted' | 'grant' | 'revoke' | 'grantOwners' | 'revokeAll'
  >
  packages(): Promise<readonly ManagedSessionPackage[]>
  /** The check `start` and `send` run; a grant stores what it returns. */
  workspaceRoot(path: string): Promise<string>
  /** The canonical spelling of a path, or undefined when it no longer resolves. */
  canonical(path: string): Promise<string | undefined>
}

const refuse = (code: string) => rpcError('SEMANTIC_REJECTED', { code })

/**
 * Grants exist only for plugin rows that an installed package declares now. Rows come from fresh
 * inventory, and a package whose manifest cannot be read declares none, so its grants go too: the
 * owner grants again. Run after every package change and before every grant admin call.
 */
export async function pruneOrphanGrants(
  records: Pick<ManagedSessionRecords, 'grantOwners' | 'revokeAll'>,
  packages: () => Promise<readonly ManagedSessionPackage[]>,
): Promise<void> {
  const live = new Set(
    (await packages()).flatMap((pkg) => [...pkg.owners].map((owner) => grantKey(pkg.packageId, owner))),
  )
  for (const key of records.grantOwners()) if (!live.has(key)) records.revokeAll(key)
}

/**
 * Every grant of a package being removed, whatever rows its manifest declares or fails to. Throws
 * when the store does, so the removal is refused: a package installed later under the same id must
 * not inherit them.
 */
export function revokePackageGrants(
  records: Pick<ManagedSessionRecords, 'grantOwners' | 'revokeAll'>,
  packageId: string,
): void {
  const prefix = grantKey(packageId, '')
  for (const key of records.grantOwners()) if (key.startsWith(prefix)) records.revokeAll(key)
}

/** `pruneOrphanGrants` for a caller with nobody to throw to: a failure is reported and the grants stay. */
export function quietGrantPruner(
  records: Pick<ManagedSessionRecords, 'grantOwners' | 'revokeAll'>,
  packages: () => Promise<readonly ManagedSessionPackage[]>,
  warn: (message: string) => void,
): () => Promise<void> {
  return () =>
    pruneOrphanGrants(records, packages).catch((error) =>
      warn(
        `pruning managed workspace grants failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
}

/**
 * The owner's grants, named by package. Records are keyed by package and plugin row; rows never leave
 * this module, so nothing an owner reads or types carries a row hash.
 */
export function managedWorkspaceGrants(ports: ManagedWorkspaceGrantPorts) {
  const prune = () => pruneOrphanGrants(ports.records, ports.packages)
  const installed = async (packageId: string) => {
    await prune()
    const pkg = (await ports.packages()).find((row) => row.packageId === packageId)
    if (!pkg) throw refuse('PACKAGE_NOT_INSTALLED')
    return pkg
  }
  return {
    prune,
    async list(packageId?: string): Promise<ManagedWorkspaceGrantsList> {
      if (packageId === undefined) await prune()
      const packages = packageId === undefined ? await ports.packages() : [await installed(packageId)]
      return {
        items: packages.flatMap((pkg) =>
          [
            ...new Set(
              [...pkg.owners].flatMap((owner) => ports.records.grants(grantKey(pkg.packageId, owner))),
            ),
          ]
            .sort()
            .map((workspace) => ({ packageId: pkg.packageId, workspace })),
        ),
      }
    },
    async grant(packageId: string, workspace: string): Promise<ManagedWorkspaceGrantChange> {
      await prune()
      const packages = await ports.packages()
      const pkg = packages.find((row) => row.packageId === packageId)
      if (!pkg) throw refuse('PACKAGE_NOT_INSTALLED')
      if (!pkg.sessions || pkg.owners.size === 0) throw refuse('PACKAGE_WITHOUT_MANAGED_SESSIONS')
      // Row ids are author-chosen; a row another installed package also declares names no one plugin.
      if (packages.some((row) => row !== pkg && [...pkg.owners].some((owner) => row.owners.has(owner))))
        throw refuse('PLUGIN_ROW_AMBIGUOUS')
      let root: string
      try {
        root = await ports.workspaceRoot(workspace)
      } catch {
        throw refuse('WORKSPACE_NOT_REGISTERED')
      }
      const keys = [...pkg.owners].map((owner) => grantKey(packageId, owner))
      const changed = keys.some((key) => !ports.records.granted(key, root))
      for (const key of keys) ports.records.grant(key, root)
      return { packageId, workspace: root, changed }
    },
    /** Works for a disabled package, and for a workspace that was removed or deleted since. */
    async revoke(packageId: string, workspace: string): Promise<ManagedWorkspaceGrantChange> {
      const pkg = await installed(packageId)
      const canonical = await ports.canonical(workspace)
      const spellings = [
        ...new Set([canonical, isAbsolute(workspace) ? resolve(workspace) : workspace]),
      ].filter((path): path is string => path !== undefined)
      let revoked: string | undefined
      for (const path of spellings)
        for (const owner of pkg.owners)
          if (ports.records.granted(grantKey(packageId, owner), path)) {
            ports.records.revoke(grantKey(packageId, owner), path)
            revoked ??= path
          }
      return { packageId, workspace: revoked ?? canonical ?? workspace, changed: revoked !== undefined }
    },
  }
}

/**
 * The owner's admin methods. Unix admin connections only: the loopback Web listener, plugins,
 * services, the managed-service lane and agent tools have no route to them.
 */
export function registerManagedWorkspaceGrants(
  endpoint: LocalEndpoint,
  authority: PackageAdminAuthorityResolver,
  grants: ReturnType<typeof managedWorkspaceGrants> | undefined,
): void {
  const register = <P>(
    name: MethodName,
    write: boolean,
    action: (service: ReturnType<typeof managedWorkspaceGrants>, params: P) => Promise<unknown>,
  ) =>
    endpoint.register(name, async (params, c) => {
      requireLocalAdminAuthority(c, authority, write)
      if (!grants) throw refuse('MANAGED_SESSIONS_UNAVAILABLE')
      return action(grants, params as P)
    })
  register<ManagedWorkspaceGrantsListParams>('_agnes/v1/admin.managedWorkspaces.list', false, (g, p) =>
    g.list(p.packageId),
  )
  register<ManagedWorkspaceGrantParams>('_agnes/v1/admin.managedWorkspaces.grant', true, (g, p) =>
    g.grant(p.packageId, p.workspace),
  )
  register<ManagedWorkspaceGrantParams>('_agnes/v1/admin.managedWorkspaces.revoke', true, (g, p) =>
    g.revoke(p.packageId, p.workspace),
  )
}
