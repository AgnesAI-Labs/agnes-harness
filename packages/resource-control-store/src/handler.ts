import {
  type McpServerDefinitionInput,
  RESOURCE_CONTROL_METHODS,
  type ResourceControlMethodName,
  rpcError,
  validateResourceControlCall,
} from '@agnes/protocol'
import {
  type ResourceAuthority,
  type ResourceAuthorityResolver,
  type ResourceCallContext,
  requireResourceAuthority,
  requireSecretUse,
} from './permissions.js'

/**
 * Durable state is deliberately behind this port: production composition supplies the profile journal;
 * the handler never treats a missing lifecycle adapter as a successful reconciliation.
 */
export type ResourceStateStore = Readonly<{
  call(
    method: ResourceControlMethodName,
    params: Record<string, unknown>,
    authority: ResourceAuthority,
  ): Promise<unknown>
  recover(): Promise<void>
  /** Needed for persisted MCP test requests, whose RPC params deliberately contain no definition. */
  requiresSecretUse?(
    method: ResourceControlMethodName,
    params: Record<string, unknown>,
    authority: ResourceAuthority,
  ): Promise<boolean>
}>
export type ResourceControlService = Readonly<{
  call(
    method: ResourceControlMethodName,
    params: unknown,
    authority: ResourceAuthority | undefined,
  ): Promise<unknown>
  recover(): Promise<void>
}>
export type ResourceControlEndpoint = Readonly<{
  register(
    method: ResourceControlMethodName,
    handler: (params: unknown, context: ResourceCallContext) => Promise<unknown>,
  ): void
}>
class Service implements ResourceControlService {
  constructor(private readonly store: ResourceStateStore) {}
  async call(
    method: ResourceControlMethodName,
    params: unknown,
    authority: ResourceAuthority | undefined,
  ): Promise<unknown> {
    const principal = requireResourceAuthority(method, authority)
    const checked = validateResourceControlCall(method, 'params', params)
    if (!checked.ok) throw rpcError('INVALID_PARAMS', { method })
    const value = checked.value as Record<string, unknown>
    if (
      method === '_agnes/v1/skills.refresh' &&
      value.reinstall !== undefined &&
      !principal.permissions.includes('resources.skills.write')
    )
      throw rpcError('CAPABILITY_DENIED', { code: 'SKILL_REINSTALL_AUTHORITY_REQUIRED' })
    // Params are validated above, so this is a discriminated union check, not a recursive
    // string scan that could accidentally treat display text as a credential reference.
    const definitionUsesSecret = (definition: McpServerDefinitionInput | undefined): boolean =>
      definition?.secretBinding.kind !== undefined && definition.secretBinding.kind !== 'none'
    const directDefinition =
      method === '_agnes/v1/mcp.servers.create' || method === '_agnes/v1/mcp.servers.update'
        ? (value.definition as McpServerDefinitionInput)
        : undefined
    const persistedUse =
      method === '_agnes/v1/mcp.servers.test'
        ? ((await this.store.requiresSecretUse?.(method, value, principal)) ?? false)
        : false
    requireSecretUse(principal, definitionUsesSecret(directDefinition) || persistedUse)
    const result = await this.store.call(method, value, principal)
    if (!validateResourceControlCall(method, 'result', result).ok)
      throw rpcError('INTERNAL_ERROR', { code: 'RESULT_INVALID', method })
    return result
  }
  recover(): Promise<void> {
    return this.store.recover()
  }
}
export function createResourceControlService(store: ResourceStateStore): ResourceControlService {
  return new Service(store)
}
export function registerResourceControl(
  endpoint: ResourceControlEndpoint,
  service: ResourceControlService,
  authority: ResourceAuthorityResolver,
): void {
  for (const method of Object.keys(RESOURCE_CONTROL_METHODS) as ResourceControlMethodName[])
    endpoint.register(method, (params, context) => service.call(method, params, authority(context)))
}
