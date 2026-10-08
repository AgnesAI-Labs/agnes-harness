import { realpath } from 'node:fs/promises'
import { loadContextRules, readContextConfig, writeContextConfig } from '@agnes/base'
import { applyPlanCommand } from '@agnes/base/plan-mode'
import { createSearchAdmin } from '@agnes/base/search'
import { HistoryIndexError, searchHistoryDirectory } from '@agnes/history-index'
import {
  createCompositionAdmin,
  createCredentialStore,
  type ResolvedProfile,
  resolveFileSecretsDirectory,
} from '@agnes/host'
import { rpcError } from '@agnes/protocol'
import type {
  AdminBundlesSave,
  AdminContextParams,
  AdminHistoryParams,
  AdminMcpOAuthSave,
  AdminMemoryParams,
  AdminPlanParams,
} from '@agnes/protocol/gen/app-server'
import { credentialRefFor } from '@agnes/resource-control-runtime'

/** One daemon-owned closure for local settings; HTTP adapters never access credentials/files. */
export function createAppServerAdmin(options: {
  home: string
  dataDir: string
  profileDir: string
  resolveProfile(bundles?: readonly string[]): Promise<ResolvedProfile>
  memory?(
    input: AdminMemoryParams,
  ): Promise<Pick<import('@agnes/protocol/gen/app-server').AdminMemoryResult, 'inspection' | 'file'>>
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
    async memory(input: AdminMemoryParams) {
      const { items } = await options.workspaces()
      if (!items.some((item) => item.available && item.path === input.cwd) || !options.memory)
        throw rpcError('CAPABILITY_DENIED')
      const value = await options.memory({ ...input, cwd: await realpath(input.cwd) })
      return { workspaces: items.map(({ path, available }) => ({ path, available })), ...value }
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
