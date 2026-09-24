import {
  canAccessPackageAdmin,
  type PackageAdminMethodName,
  type PackageAdminPermission,
  rpcError,
} from '@agnes/protocol'
import type { CallContext } from '../local/endpoint.js'

/**
 * Package authority is minted by the daemon composition root. `clientId` is copied from the
 * initialized connection only to bind an idempotency namespace; it is never a caller grant.
 */
export type PackageAdminAuthority = Readonly<{
  audience: 'admin'
  principalId: string
  /** Server-established connection namespace for effect/cancel idempotency. */
  clientId: string
  permissions: readonly PackageAdminPermission[]
  /**
   * Optional method allowlist, intersected with the permission check.
   *
   * A grant that exists for one narrow UI need must not widen into general package management just
   * because the method's declared permission happens to be broad: every read in this namespace asks
   * for `packages.read`, so a permission alone cannot express "the skin roster and nothing else".
   */
  methods?: readonly PackageAdminMethodName[]
}>

export type PackageAdminAuthorityResolver = (context: CallContext) => PackageAdminAuthority | undefined

export const PACKAGE_ADMIN_ALL_PERMISSIONS = Object.freeze([
  'packages.read',
  'packages.install',
  'packages.trust',
  'packages.activate',
  'packages.remove',
  'catalog.configure',
  'extensions.execute',
] as const satisfies readonly PackageAdminPermission[])

/** Unix/in-process composition may opt in explicitly; WebSocket transport must use a different resolver. */
export function localPackageAdminAuthority(
  permissions: readonly PackageAdminPermission[] = PACKAGE_ADMIN_ALL_PERMISSIONS,
): PackageAdminAuthorityResolver {
  return (context) =>
    context.conn.authKind === 'local' && context.conn.credentialKind === 'local'
      ? {
          audience: 'admin',
          // Do not collapse every Unix credential into "local": auth may have established a more
          // precise local principal for this process.
          principalId: context.conn.principalId,
          // Written during initialize, then fixed for the connection. Request bodies are bound to
          // this namespace before they can participate in idempotency.
          clientId: context.conn.clientId,
          permissions,
        }
      : undefined
}

/**
 * The workbench reads skin and client-module rosters over its ordinary loopback Web connection,
 * which has no package-administration grant. These reads mutate nothing and carry no filesystem
 * path, so the Web audience is granted exactly the two roster methods.
 *
 * Deliberately NOT granted, even though their declared permission is the same `packages.read`:
 * `skins.read` and `clientModules.read` (those belong to the launcher's private Node connection),
 * the catalog, operations, pins, and every effect method.
 */
export const localWebSkinReadAuthority: PackageAdminAuthorityResolver = (context) =>
  context.conn.authKind === 'local' && context.conn.credentialKind === 'local'
    ? {
        audience: 'admin',
        principalId: context.conn.principalId,
        clientId: context.conn.clientId,
        permissions: ['packages.read'],
        methods: ['_agnes/v1/skins.list', '_agnes/v1/clientModules.list'],
      }
    : undefined

/** The safe default for browsers, chat connections, surface credentials and unconfigured remotes. */
export const denyPackageAdminAuthority: PackageAdminAuthorityResolver = () => undefined

export function requirePackageAdmin(
  method: PackageAdminMethodName,
  authority: PackageAdminAuthority | undefined,
): PackageAdminAuthority {
  const withinAllowlist = authority?.methods === undefined || authority.methods.includes(method)
  if (!authority || !withinAllowlist || !canAccessPackageAdmin(method, authority))
    throw rpcError('CAPABILITY_DENIED', {
      method,
      reason: 'package administration requires server-granted admin authority',
    })
  return authority
}

/** Enforces permissions added by optional composite contracts after strict parameter validation. */
export function requirePackageAdminPermissions(
  method: PackageAdminMethodName,
  authority: PackageAdminAuthority,
  permissions: readonly PackageAdminPermission[],
): void {
  if (permissions.some((permission) => !authority.permissions.includes(permission)))
    throw rpcError('CAPABILITY_DENIED', {
      method,
      reason: 'package administration requires server-granted composite authority',
    })
}
