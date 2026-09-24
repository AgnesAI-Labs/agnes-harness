import {
  type AuthInteraction,
  type CredentialStore,
  createModels,
  type ModelAuth,
  type OAuthCredential,
  type Provider,
} from '@earendil-works/pi-ai'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot'
import { kimiCodingProvider } from '@earendil-works/pi-ai/providers/kimi-coding'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { modelRecord } from './api-key-providers.js'
import { PiAdapter } from './index.js'

// pi-ai's default variable imports cannot survive a single-file Node bundle.
// Despite its name, this public entry registers ordinary JS flows for any bundler.
registerBunOAuthFlows()

export type SubscriptionProviderId = 'anthropic' | 'github-copilot' | 'kimi-coding' | 'openai-codex' | 'xai'
export type SubscriptionCredential = OAuthCredential
export type SubscriptionCredentialStore = CredentialStore
export type SubscriptionInteraction = AuthInteraction
export type SubscriptionLoginMethod = 'browser' | 'device_code'
export type SubscriptionModel = ReturnType<typeof modelRecord> & { api: string; baseUrl: string }

type SubscriptionSpec = Readonly<{
  id: SubscriptionProviderId
  displayName: string
  primaryApi: string
  baseUrl: string
  loginMethods: readonly SubscriptionLoginMethod[]
  authOrigins: readonly string[]
  factory(): Provider
}>

const SPECS: readonly SubscriptionSpec[] = [
  {
    id: 'openai-codex',
    displayName: 'OpenAI Codex · ChatGPT 订阅',
    primaryApi: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    loginMethods: ['browser', 'device_code'],
    authOrigins: ['https://auth.openai.com'],
    factory: openaiCodexProvider,
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic · Claude Pro/Max',
    primaryApi: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    loginMethods: ['browser'],
    authOrigins: ['https://claude.ai'],
    factory: anthropicProvider,
  },
  {
    id: 'github-copilot',
    displayName: 'GitHub Copilot 订阅',
    primaryApi: 'openai-responses',
    baseUrl: 'https://api.individual.githubcopilot.com',
    loginMethods: ['device_code'],
    authOrigins: ['https://github.com'],
    factory: githubCopilotProvider,
  },
  {
    id: 'kimi-coding',
    displayName: 'Kimi Code 订阅',
    primaryApi: 'anthropic-messages',
    baseUrl: 'https://api.kimi.com/coding',
    loginMethods: ['device_code'],
    authOrigins: ['https://auth.kimi.com', 'https://www.kimi.com'],
    factory: kimiCodingProvider,
  },
  {
    id: 'xai',
    displayName: 'xAI · SuperGrok/X Premium',
    primaryApi: 'openai-responses',
    baseUrl: 'https://api.x.ai/v1',
    loginMethods: ['device_code'],
    authOrigins: ['https://auth.x.ai', 'https://accounts.x.ai'],
    factory: xaiProvider,
  },
] as const

function catalogue(spec: SubscriptionSpec): SubscriptionModel[] {
  const provider = spec.factory()
  if (
    provider.id !== spec.id ||
    provider.baseUrl !== spec.baseUrl ||
    provider.auth.oauth?.isSubscription !== true
  )
    throw new Error('SUBSCRIPTION_CATALOG_INVALID')
  const models = provider.getModels().map((model) => ({
    ...modelRecord({ id: spec.id, api: model.api, baseUrl: model.baseUrl }, model),
    api: model.api,
    baseUrl: model.baseUrl,
  }))
  if (!models.length || models.some((model) => model.baseUrl !== spec.baseUrl))
    throw new Error('SUBSCRIPTION_CATALOG_INVALID')
  return models
}

export type SubscriptionProviderEntry = Readonly<{
  id: SubscriptionProviderId
  route: SubscriptionProviderId
  displayName: string
  api: string
  baseUrl: string
  credentialRef: `secret://${SubscriptionProviderId}/default`
  loginMethods: readonly SubscriptionLoginMethod[]
  authOrigins: readonly string[]
  models(): SubscriptionModel[]
  createAdapter(api?: string, route?: string): PiAdapter
}>

export const SUBSCRIPTION_PROVIDER_REGISTRY: readonly SubscriptionProviderEntry[] = SPECS.map((spec) => ({
  id: spec.id,
  route: spec.id,
  displayName: spec.displayName,
  api: spec.primaryApi,
  baseUrl: spec.baseUrl,
  credentialRef: `secret://${spec.id}/default`,
  loginMethods: spec.loginMethods,
  authOrigins: spec.authOrigins,
  models: () => catalogue(spec),
  createAdapter(api = spec.primaryApi, route = spec.id) {
    const models = catalogue(spec).filter((model) => model.api === api)
    if (!models.length) throw new Error('SUBSCRIPTION_CATALOG_INVALID')
    return new PiAdapter({ manualRoutes: [{ route, api, baseUrl: spec.baseUrl, models }] })
  },
}))

export function getSubscriptionProvider(id: string): SubscriptionProviderEntry | undefined {
  return SUBSCRIPTION_PROVIDER_REGISTRY.find((entry) => entry.id === id)
}

export async function subscriptionCredentialAuth(
  id: SubscriptionProviderId,
  credential: OAuthCredential,
): Promise<ModelAuth> {
  const entry = getSubscriptionProvider(id)
  const provider = SPECS.find((spec) => spec.id === id)?.factory()
  if (!entry || !provider?.auth.oauth) throw new Error('SUBSCRIPTION_AUTH_FAILED')
  return checkedAuth(entry, await provider.auth.oauth.toAuth(credential), credential)
}

export function subscriptionModels(
  id: SubscriptionProviderId,
  credential?: OAuthCredential,
): SubscriptionModel[] {
  const entry = getSubscriptionProvider(id)
  const provider = SPECS.find((spec) => spec.id === id)?.factory()
  if (!entry || !provider) throw new Error('SUBSCRIPTION_CATALOG_INVALID')
  const allowed = new Set(
    (provider.filterModels
      ? provider.filterModels(provider.getModels(), credential)
      : provider.getModels()
    ).map((model) => model.id),
  )
  return entry.models().filter((model) => allowed.has(model.id))
}

function checkedAuth(
  entry: SubscriptionProviderEntry,
  auth: ModelAuth,
  credential?: OAuthCredential,
): ModelAuth {
  if (!auth.apiKey?.trim() && Object.keys(auth.headers ?? {}).length === 0)
    throw new Error('SUBSCRIPTION_AUTH_FAILED')
  if (!auth.baseUrl) return auth
  const url = new URL(auth.baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('SUBSCRIPTION_AUTH_FAILED')
  if (entry.id !== 'github-copilot') {
    if (url.href.replace(/\/$/, '') !== entry.baseUrl.replace(/\/$/, ''))
      throw new Error('SUBSCRIPTION_AUTH_FAILED')
    return auth
  }
  const enterprise = typeof credential?.enterpriseUrl === 'string' ? credential.enterpriseUrl : undefined
  const githubHosted = /^api(?:\.[a-z0-9-]+)*\.githubcopilot\.com$/i.test(url.hostname)
  const enterpriseHosted = enterprise && url.hostname === `copilot-api.${enterprise}`
  if (!githubHosted && !enterpriseHosted) throw new Error('SUBSCRIPTION_AUTH_FAILED')
  return auth
}

function sameAuth(left: ModelAuth, right: ModelAuth): boolean {
  if (left.apiKey !== right.apiKey || left.baseUrl !== right.baseUrl) return false
  const entries = (value: ModelAuth): [string, string | null][] =>
    Object.entries(value.headers ?? {})
      .map(([key, headerValue]) => [key.toLowerCase(), headerValue] as [string, string | null])
      .sort(([a], [b]) => a.localeCompare(b))
  const a = entries(left)
  const b = entries(right)
  return (
    a.length === b.length &&
    a.every(([key, value], index) => b[index]?.[0] === key && b[index]?.[1] === value)
  )
}

/** No ambient lookup: every instance is scoped to one Host-owned grant. */
export function subscriptionAuth(id: SubscriptionProviderId, credentials: CredentialStore) {
  const entry = getSubscriptionProvider(id)
  const provider = SPECS.find((spec) => spec.id === id)?.factory()
  const oauth = provider?.auth.oauth
  if (!entry || !provider || !oauth) throw new Error('SUBSCRIPTION_AUTH_FAILED')
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  })
  models.setProvider(provider)
  return {
    login: (interaction: AuthInteraction) => models.login(id, 'oauth', interaction),
    async resolve(signal: AbortSignal): Promise<ModelAuth> {
      try {
        const result = await models.getAuth(id, { signal })
        if (!result) throw new Error('missing')
        const credential = await credentials.read(id, { signal })
        return checkedAuth(entry, result.auth, credential?.type === 'oauth' ? credential : undefined)
      } catch {
        throw new Error('SUBSCRIPTION_AUTH_FAILED')
      }
    },
    async recoverRejected(rejected: ModelAuth, signal: AbortSignal): Promise<boolean> {
      let recoverable = false
      await credentials.modify(
        id,
        async (current) => {
          if (current?.type !== 'oauth') return undefined
          const currentAuth = checkedAuth(entry, await oauth.toAuth(current), current)
          // A concurrent request may already have rotated the rejected token. In that case leave the
          // new credential untouched but tell the caller to resolve it and retry.
          recoverable = true
          if (!sameAuth(currentAuth, rejected)) return undefined
          // Stored subscription credentials require a positive timestamp. One millisecond after the
          // epoch is both schema-valid and unambiguously expired, causing Models.getAuth() to run its
          // locked refresh path on the next resolution.
          return { ...current, expires: 1 }
        },
        { signal },
      )
      return recoverable
    },
    async available(signal: AbortSignal): Promise<SubscriptionModel[]> {
      const allowed = new Set((await models.getAvailable(id, { signal })).map((model) => model.id))
      return entry.models().filter((model) => allowed.has(model.id))
    },
  }
}

/** Real bounded inference; an offline catalogue alone is not an entitlement check. */
export async function testSubscriptionCredential(
  providerId: SubscriptionProviderId,
  auth: ModelAuth,
  modelId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const entry = getSubscriptionProvider(providerId)
  const selected = entry?.models().find((model) => model.id === modelId)
  if (!entry || !selected) return false
  const route = `test-${providerId}`
  const adapter = new PiAdapter({
    providerId,
    manualRoutes: [{ route, api: selected.api, baseUrl: entry.baseUrl, models: [selected] }],
    resolveCredential: async () => auth,
  })
  for await (const event of adapter.stream(
    route,
    {
      kind: 'inference',
      sessionKey: `agnes:config:${providerId}`,
      slot: 'primary',
      route,
      model: modelId,
      contractId: null,
      derivedHash: '0'.repeat(64),
      system: 'Reply OK.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK.' }] }],
      tools: [],
    },
    {
      signal,
      toolNames: [],
      sessionKey: `agnes:config:${providerId}`,
      retry: false,
      timeoutMs: { firstToken: 30_000, total: 30_000 },
    },
  )) {
    if (event.type === 'error')
      throw Object.assign(new Error('Subscription inference test failed'), { code: event.code })
    if (event.type === 'done') return true
  }
  return false
}

// CODEX-OAUTH-01 compatibility exports.
export type CodexCredential = SubscriptionCredential & { accountId: string }
export type CodexCredentialStore = SubscriptionCredentialStore
export type CodexInteraction = SubscriptionInteraction
export const CODEX_ID = 'openai-codex'
export const CODEX_URL = 'https://chatgpt.com/backend-api'
export const CODEX_API = 'openai-codex-responses'
export const CODEX_PROVIDER = getSubscriptionProvider(CODEX_ID) as SubscriptionProviderEntry
export const codexAuth = (credentials: CredentialStore) => {
  const auth = subscriptionAuth(CODEX_ID, credentials)
  return {
    login: auth.login,
    available: auth.available,
    async resolve(signal: AbortSignal): Promise<string> {
      try {
        const resolved = await auth.resolve(signal)
        if (!resolved.apiKey) throw new Error('missing')
        return resolved.apiKey
      } catch {
        throw new Error('CODEX_AUTH_FAILED')
      }
    },
  }
}
export const testCodexCredential = (key: string, modelId: string, signal: AbortSignal) =>
  testSubscriptionCredential(CODEX_ID, { apiKey: key }, modelId, signal)
