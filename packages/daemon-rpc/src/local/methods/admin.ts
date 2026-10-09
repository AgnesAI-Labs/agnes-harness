import type { AppServerAdmin } from '@agnes/daemon-admin/app-server'
import {
  type PackageAdminAuthorityResolver,
  requireLocalAdminAuthority,
} from '@agnes/daemon-admin/packages/index'
import type { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { type AdminMethodName, rpcError } from '@agnes/protocol'
import type {
  AdminBundlesSave,
  AdminContextParams,
  AdminHistoryParams,
  AdminMcpOAuthSave,
  AdminMemoryParams,
  AdminPlanParams,
} from '@agnes/protocol/gen/app-server'

// Preserve the declared public factory export; implementations live with the admin owner.
export { type AppServerAdmin, createAppServerAdmin } from '@agnes/daemon-admin/app-server'

export function registerAppServerAdmin(
  endpoint: LocalEndpoint,
  service: AppServerAdmin,
  authority: PackageAdminAuthorityResolver,
): void {
  const register = (name: AdminMethodName, write: boolean, action: (input: unknown) => Promise<unknown>) =>
    endpoint.register(name, async (input, ctx) => {
      requireLocalAdminAuthority(ctx, authority, write)
      try {
        return await action(input)
      } catch (error) {
        if (error && typeof error === 'object' && 'data' in error && 'code' in error) throw error
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        throw rpcError('SEMANTIC_REJECTED', {
          reason:
            typeof code === 'string' && /^(?:CONFIG|MEMORY)_[A-Z_]{1,48}$/.test(code)
              ? code
              : 'CONFIG_FAILED',
        })
      }
    })
  register('_agnes/v1/admin.bundles.get', false, () => service.bundles())
  register('_agnes/v1/admin.bundles.save', true, (input) => service.saveBundles(input as AdminBundlesSave))
  register('_agnes/v1/admin.composition.get', false, (input) =>
    service.composition((input as { preset?: string }).preset),
  )
  register('_agnes/v1/admin.search.get', false, () => service.search('GET', 'search', {}))
  register('_agnes/v1/admin.search.save', true, (input) => service.search('PUT', 'search', input))
  register('_agnes/v1/admin.search.test', true, (input) => service.search('POST', 'search/test', input))
  register('_agnes/v1/admin.history.search', false, (input) => service.history(input as AdminHistoryParams))
  register('_agnes/v1/admin.plan', true, (input) => service.plan(input as AdminPlanParams))
  register('_agnes/v1/admin.mcp.oauth.save', true, (input) =>
    service.saveMcpOAuth(input as AdminMcpOAuthSave),
  )
  // Config writes are optional on context; conservatively require activate for this combined method.
  register('_agnes/v1/admin.triggers', true, (input) =>
    service.triggers(input as import('@agnes/protocol/gen/app-server').WebhookRequest),
  )
  register('_agnes/v1/admin.memory', true, (input) => service.memory(input as AdminMemoryParams))
  register('_agnes/v1/admin.context', true, (input) => service.context(input as AdminContextParams))
}
