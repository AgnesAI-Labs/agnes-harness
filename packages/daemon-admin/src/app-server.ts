import { readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { loadContextRules, readContextConfig, writeContextConfig } from '@agnes/base'
import { AutoReviewSettingsStore } from '@agnes/base/approval-policy'
import { createSearchAdmin } from '@agnes/base/search'
import { HistoryIndexError, searchHistoryDirectory } from '@agnes/history-index'
import {
  CredentialStoreError,
  createCompositionAdmin,
  createCredentialStore,
  createMcpOAuthStore,
  createSecretsEnv,
  createSecretsFile,
  fileSecretsDir,
  type ResolvedProfile,
  resolveFileSecretsDirectory,
} from '@agnes/host'
import { withPackageVerification } from '@agnes/package-manager'
import { type AutoReviewConfig, type McpServerDescriptor, rpcError } from '@agnes/protocol'
import type {
  AdminBundlesSave,
  AdminContextParams,
  AdminHistoryParams,
  AdminMcpOAuthComplete,
  AdminMcpOAuthGet,
  AdminMemoryParams,
  AdminPlanParams,
} from '@agnes/protocol/gen/app-server'
import {
  completeMcpOAuthLogin,
  McpOAuthNeedsReconnectError,
  type McpOAuthRead,
  type McpOAuthSummary,
  mcpOAuthFailureReason,
  refreshMcpOAuth,
  signOutMcpOAuth,
  summarizeMcpOAuth,
} from '@agnes/resource-control-runtime'
import { type CredentialConfiguration, savedCredentialConfigurations } from './credential-references.js'
import { createCredentialAdmin } from './credentials.js'
import { createWebhookService, type TriggerSessionInput } from './webhooks/service.js'

/** Local settings owner exposes only read/save operations to authenticated RPC adapters. */
export function createAutoReviewSettings(dataDir: string, profile: string, enabled = false) {
  const store = new AutoReviewSettingsStore(dataDir, profile, enabled)
  return {
    read: () => store.read(),
    save: (config: AutoReviewConfig) => store.save(config),
  }
}

/** One daemon-owned closure for local settings; HTTP adapters never access credentials/files. */
export function createAppServerAdmin(options: {
  home: string
  dataDir: string
  profileDir: string
  resolveProfile(bundles?: readonly string[]): Promise<ResolvedProfile>
  inspectProfile?(bundles?: readonly string[]): Promise<ResolvedProfile>
  memory?(
    input: AdminMemoryParams,
  ): Promise<
    Pick<import('@agnes/protocol/gen/app-server').AdminMemoryResult, 'inspection' | 'file' | 'saved'>
  >
  triggerSession?(input: TriggerSessionInput): Promise<void>
  credentialConfigurations?(): Promise<CredentialConfiguration[]>
  plan?(input: AdminPlanParams): Promise<{ active: boolean; text: string }>
  workspaces(): Promise<{ items: { path: string; available: boolean }[] }>
  /** One MCP server definition of a profile, or undefined when there is none. */
  mcpServer?(profile: string, serverId: string): Promise<McpServerDescriptor['definition'] | undefined>
  /** Test seam for the sign-in code exchange; production uses global fetch. */
  fetchImpl?: typeof fetch
}) {
  const composition = createCompositionAdmin({
    profileDir: options.profileDir,
    resolveProfile: options.resolveProfile,
    ...(options.inspectProfile ? { inspectProfile: options.inspectProfile } : {}),
  })
  resolveFileSecretsDirectory({ home: options.home, dataDir: options.dataDir })
  const credentials = createCredentialStore({ root: options.home })
  const oauthStore = createMcpOAuthStore({ root: options.home })
  const oauthServer = async (profile: string, serverId: string) => {
    const definition = await options.mcpServer?.(profile, serverId)
    const { transport, secretBinding } = definition ?? {}
    // Sign-in is for a remote server whose credential is OAuth, or not set yet.
    if (
      !transport ||
      transport.kind === 'stdio' ||
      !secretBinding ||
      !['oauth', 'none'].includes(secretBinding.kind)
    )
      throw rpcError('SEMANTIC_REJECTED', { reason: 'MCP_OAUTH_SERVER_UNAVAILABLE' })
    return {
      serverUrl: new URL(transport.url),
      binding: secretBinding.kind === 'oauth' ? secretBinding : undefined,
    }
  }
  /** A static client ID and, when it has one, its secret read from the credential store. */
  const staticClientOf = async (
    binding: { staticClientId?: string; clientSecretRef?: string } | undefined,
  ): Promise<{ clientId: string; clientSecret?: string } | undefined> => {
    if (!binding?.staticClientId) return undefined
    const ref = binding.clientSecretRef
    const stored = ref ? await credentials.read(ref) : undefined
    if (ref && stored?.kind !== 'api-key')
      throw rpcError('SEMANTIC_REJECTED', { reason: 'CONFIG_CREDENTIAL_NOT_FOUND' })
    return {
      clientId: binding.staticClientId,
      ...(stored?.kind === 'api-key' ? { clientSecret: stored.value } : {}),
    }
  }
  const unreadable = (error: unknown) =>
    error instanceof CredentialStoreError && (error.reason === 'schema' || error.reason === 'invalid-json')
  /** The stored sign-in, or null when there is none or the file cannot be read. */
  const readOAuth = async (serverId: string): Promise<McpOAuthRead> => {
    try {
      return await oauthStore.read(serverId)
    } catch (error) {
      if (unreadable(error)) return null
      throw error
    }
  }
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
  const webhookSecrets = async () => {
    const profile = await options.resolveProfile()
    const config = profile.adapters.secrets
    if (config.kind === 'env') return { resolver: createSecretsEnv(), dir: undefined }
    if (config.kind !== 'file') throw new Error('Webhook secrets unavailable')
    const dir = resolveFileSecretsDirectory({
      home: options.home,
      dataDir: options.dataDir,
      ...(config.path ? { path: config.path } : {}),
    })
    return { resolver: createSecretsFile({ dir }), dir }
  }
  const triggers = createWebhookService({
    dataDir: options.dataDir,
    workspaces: options.workspaces,
    ...(options.triggerSession ? { createSession: options.triggerSession } : {}),
    resolveSecret: async (ref) => (await webhookSecrets()).resolver.resolve(ref),
    secretRefs: async () => {
      const { dir } = await webhookSecrets().catch(() => ({ dir: undefined }))
      if (!dir) return []
      const refs: string[] = []
      for (const ns of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!ns.isDirectory() || !/^[a-z0-9-]+$/.test(ns.name)) continue
        for (const item of await readdir(join(dir, ns.name), { withFileTypes: true }))
          if (item.isFile() && /^[a-z0-9._-]+$/.test(item.name)) refs.push(`secret://${ns.name}/${item.name}`)
      }
      return refs.sort().slice(0, 4096)
    },
  })
  const genericCredentials = createCredentialAdmin({
    home: options.home,
    dataDir: options.dataDir,
    writableStore: async () => {
      const config = (await options.resolveProfile()).adapters.secrets
      return (
        config.kind === 'file' &&
        resolveFileSecretsDirectory({
          home: options.home,
          dataDir: options.dataDir,
          ...(config.path ? { path: config.path } : {}),
        }) === fileSecretsDir(options.home)
      )
    },
    configurations: () =>
      withPackageVerification(async () => {
        if (!options.credentialConfigurations) throw new Error('credential reference inspection unavailable')
        const profile = await options.resolveProfile()
        const snapshot = await triggers.handle({ action: 'list' })
        if (!snapshot.snapshot) throw new Error('trigger reference inspection unavailable')
        return [
          { kind: 'profile', profile: profile.name, configId: 'resolved', value: profile },
          ...(await savedCredentialConfigurations(options.home, options.dataDir)),
          ...snapshot.snapshot.rules.map((rule) => ({
            kind: 'trigger' as const,
            profile: profile.name,
            configId: rule.id,
            value: rule,
          })),
          ...(await options.credentialConfigurations()),
        ]
      }),
  })
  return {
    observeTriggerSession: triggers.observeSession,
    triggers: triggers.handle,
    credentials: genericCredentials.call,
    bundles: () => composition.bundles(),
    saveBundles: (input: AdminBundlesSave) => composition.saveBundles(input),
    composition: (preset?: string) => composition.dump(preset),
    async search(method: string, path: string, body: unknown) {
      const result = await search.handle(method, path, body)
      if (result.status !== 200) throw rpcError('SEMANTIC_REJECTED', { reason: 'SEARCH_INVALID' })
      return result.body
    },
    /** Sign-in state without any token or secret. A credential file that cannot be read shows as
     * signed out, so a fresh sign-in can replace it. */
    async getMcpOAuth(input: AdminMcpOAuthGet): Promise<McpOAuthSummary> {
      await oauthServer(input.profile, input.serverId)
      return summarizeMcpOAuth(await readOAuth(input.serverId))
    },
    /** Exchanges the code here, so a static client secret is read from the credential store and
     * never leaves the daemon. A registered client's secret comes from the caller. */
    async completeMcpOAuth(input: AdminMcpOAuthComplete) {
      const { serverUrl, binding } = await oauthServer(input.profile, input.serverId)
      const staticClient = await staticClientOf(binding)
      const { profile: _profile, ...params } = input
      try {
        await completeMcpOAuthLogin({
          ...params,
          serverUrl,
          ...(staticClient ? { staticClient } : {}),
          store: oauthStore,
          fetchImpl: options.fetchImpl ?? fetch,
        })
      } catch (error) {
        throw readableOAuthError(error)
      }
      return {}
    },
    /** Signs in again with the stored refresh token, so no browser is needed. Answers `signedIn:
     * false` without any request when there is no refresh token, or when more scope is needed: a
     * refresh keeps the granted scope, so only the browser sign-in can ask for it. A refresh the
     * server refuses, or that finds the server moved, also answers false; other faults are errors. */
    async refreshMcpOAuth(input: AdminMcpOAuthGet): Promise<{ signedIn: boolean }> {
      const { serverUrl, binding } = await oauthServer(input.profile, input.serverId)
      const seen = await readOAuth(input.serverId)
      if (!seen || 'legacy' in seen || seen.requiredScope.length || !seen.tokens?.refreshToken)
        return { signedIn: false }
      const staticClient = await staticClientOf(binding)
      try {
        const record = await refreshMcpOAuth({
          serverId: input.serverId,
          serverUrl,
          seen,
          store: oauthStore,
          ...(staticClient ? { staticClient } : {}),
          fetchImpl: options.fetchImpl ?? fetch,
        })
        return { signedIn: record.requiredScope.length === 0 }
      } catch (error) {
        if (error instanceof McpOAuthNeedsReconnectError) return { signedIn: false }
        throw readableOAuthError(error)
      }
    },
    /** Writes the signed-out record (`epoch` + 1, no client, server or tokens); revokes nothing at
     * the authorization server. A credential file that cannot be read is replaced by that record. */
    async logoutMcpOAuth(input: AdminMcpOAuthGet): Promise<{ epoch: number }> {
      await oauthServer(input.profile, input.serverId)
      try {
        return await signOutMcpOAuth({ serverId: input.serverId, store: oauthStore })
      } catch (error) {
        if (!unreadable(error)) throw error
        return signOutMcpOAuth({ serverId: input.serverId, store: oauthStore, replaceUnreadable: true })
      }
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
      return options.plan
        ? options.plan({ ...input, cwd: await realpath(input.cwd) })
        : { active: false, text: 'Plan mode is off (provider unavailable)' }
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

/** A known sign-in failure becomes a refusal with a readable reason; anything else is unchanged. */
function readableOAuthError(error: unknown): unknown {
  const reason = mcpOAuthFailureReason(error)
  return reason ? rpcError('SEMANTIC_REJECTED', { ...reason }) : error
}
