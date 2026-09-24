import {
  canAccessResourceControl,
  type ResourceControlMethodName,
  type ResourcePermission,
  rpcError,
} from '@agnes/protocol'
export type ResourceCallContext = Readonly<{
  conn: Readonly<{
    authKind?: string
    credentialKind?: string
    principalId?: string
    clientId?: string
  }>
}>

/** Server-authenticated authority; request JSON never grants resource administration. */
export type ResourceAuthority = Readonly<{
  audience: 'admin'
  principalId: string
  clientId: string
  permissions: readonly ResourcePermission[]
}>
export type ResourceAuthorityResolver = (context: ResourceCallContext) => ResourceAuthority | undefined

export const RESOURCE_ALL_PERMISSIONS = Object.freeze([
  'resources.read',
  'resources.skills.write',
  'resources.reconcile',
  'skills.refresh',
  'skills.trust',
  'mcp.read',
  'mcp.tools.read',
  'mcp.manage',
  'mcp.trust',
  'mcp.test',
  'mcp.activate',
  'mcp.reconnect',
  'secrets.use',
] as const satisfies readonly ResourcePermission[])

export function localResourceAuthority(
  permissions: readonly ResourcePermission[] = RESOURCE_ALL_PERMISSIONS,
): ResourceAuthorityResolver {
  return (context) =>
    context.conn.authKind === 'local' &&
    context.conn.credentialKind === 'local' &&
    typeof context.conn.principalId === 'string' &&
    typeof context.conn.clientId === 'string'
      ? {
          audience: 'admin',
          principalId: context.conn.principalId,
          clientId: context.conn.clientId,
          permissions,
        }
      : undefined
}
export const denyResourceAuthority: ResourceAuthorityResolver = () => undefined
export function requireResourceAuthority(
  method: ResourceControlMethodName,
  authority: ResourceAuthority | undefined,
): ResourceAuthority {
  if (!authority || !canAccessResourceControl(method, authority))
    throw rpcError('CAPABILITY_DENIED', {
      method,
      reason: 'resource administration requires server-granted admin authority',
    })
  return authority
}
/** Conditional second gate for definitions which carry a SecretRef binding. */
export function requireSecretUse(authority: ResourceAuthority, usesSecretRef: boolean): void {
  if (usesSecretRef && !authority.permissions.includes('secrets.use'))
    throw rpcError('CAPABILITY_DENIED', {
      method: 'mcp.servers',
      reason: 'SecretRef use requires secrets.use',
    })
}
