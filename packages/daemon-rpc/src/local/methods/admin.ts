import { realpath } from 'node:fs/promises'
import { loadContextRules, readContextConfig, writeContextConfig } from '@agnes/base'
import { applyPlanCommand } from '@agnes/base/plan-mode'
import { createSearchAdmin } from '@agnes/base/search'
import type { PackageAdminAuthorityResolver } from '@agnes/daemon-admin/packages/index'
import type { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { HistoryIndexError, searchHistoryDirectory } from '@agnes/history-index'
import {
  createCompositionAdmin,
  createCredentialStore,
  type ResolvedProfile,
  resolveFileSecretsDirectory,
} from '@agnes/host'
import { type AdminMethodName, rpcError } from '@agnes/protocol'
import type {
  AdminBundlesSave,
  AdminContextParams,
  AdminHistoryParams,
  AdminMcpOAuthSave,
  AdminPlanParams,
} from '@agnes/protocol/gen/app-server'
import { credentialRefFor } from '@agnes/resource-control-runtime'

/** One daemon-owned closure for local settings; HTTP adapters never access credentials/files. */
export function createAppServerAdmin(options: {
  home: string
  dataDir: string
  profileDir: string
  resolveProfile(bundles?: readonly string[]): Promise<ResolvedProfile>
  workspaces(): Promise<{ items: { path: string; available: boolean }[] }>
}) {
  const composition = createCompositionAdmin({
    profileDir: options.profileDir,
    resolveProfile: options.resolveProfile,
  })
  resolveFileSecretsDirectory({ home: options.home, dataDir: options.dataDir })
  const credentials = createCredentialStore({ root: options.home })
  const search = createSearchAdmin({
    dataDir: options.dataDir,
    credentials: {
      async read(ref) {
        const value = await credentials.read(ref)
        return value?.kind === 'api-key' ? value.value : undefined
      },
      write: (ref, value) => credentials.putApiKey(ref, value),
      remove: (ref) => credentials.remove(ref),
    },
  })
  return {
    bundles: () => composition.bundles(),
    saveBundles: (input: AdminBundlesSave) => composition.saveBundles(input),
    composition: (preset?: string) => composition.dump(preset),
    async search(method: string, path: string, body: unknown) {
      const result = await search.handle(method, path, body)
      if (result.status !== 200) throw rpcError('SEMANTIC_REJECTED', { reason: 'SEARCH_INVALID' })
      return result.body
    },
    async saveMcpOAuth(input: AdminMcpOAuthSave) {
      await credentials.putOAuth(credentialRefFor(input.serverId), input.credential)
      return {}
    },
    async history(input: AdminHistoryParams) {
      try {
        const page = searchHistoryDirectory(options.dataDir, input)
        return { items: page.items, truncated: page.truncated, ...(page.next ? { next: page.next } : {}) }
      } catch (error) {
        if (error instanceof HistoryIndexError)
          throw rpcError(error.code === 'MULTIPLE_OWNERS' ? 'CAPABILITY_DENIED' : 'INVALID_PARAMS', {
            reason: error.code,
          })
        throw error
      }
    },
    async plan(input: AdminPlanParams) {
      const { items } = await options.workspaces()
      if (!items.some((item) => item.available && item.path === input.cwd))
        throw rpcError('CAPABILITY_DENIED')
      return applyPlanCommand(await realpath(input.cwd), input.line)
    },
    async context(input: AdminContextParams) {
      const { items } = await options.workspaces()
      let cwd: string | undefined
      if (input.cwd !== undefined) {
        if (!items.some((item) => item.available && item.path === input.cwd))
          throw rpcError('CAPABILITY_DENIED')
        cwd = await realpath(input.cwd)
      }
      const config =
        input.config === undefined
          ? readContextConfig(options.home)
          : writeContextConfig(input.config, options.home)
      const rules = cwd ? await loadContextRules(cwd, [], config, options.home) : undefined
      return {
        config,
        workspaces: items.map(({ path, available }) => ({ path, available })),
        ...(rules ? { rules } : {}),
      }
    },
  }
}
export type AppServerAdmin = ReturnType<typeof createAppServerAdmin>

export function registerAppServerAdmin(
  endpoint: LocalEndpoint,
  service: AppServerAdmin,
  authority: PackageAdminAuthorityResolver,
): void {
  const register = (name: AdminMethodName, write: boolean, action: (input: unknown) => Promise<unknown>) =>
    endpoint.register(name, async (input, ctx) => {
      const grant = authority(ctx)
      if (
        ctx.conn.authKind !== 'local' ||
        ctx.conn.credentialKind !== 'local' ||
        !grant ||
        grant.methods !== undefined ||
        !grant.permissions.includes(write ? 'packages.activate' : 'packages.read')
      )
        throw rpcError('CAPABILITY_DENIED')
      try {
        return await action(input)
      } catch (error) {
        if (error && typeof error === 'object' && 'data' in error && 'code' in error) throw error
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        throw rpcError('SEMANTIC_REJECTED', {
          reason: typeof code === 'string' && /^CONFIG_[A-Z_]{1,48}$/.test(code) ? code : 'CONFIG_FAILED',
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
  register('_agnes/v1/admin.context', true, (input) => service.context(input as AdminContextParams))
}
