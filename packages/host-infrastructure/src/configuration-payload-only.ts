import {
  API_KEY_PROVIDER_REGISTRY,
  getApiKeyProvider,
  JEV_WIRE_API,
  JevAdapter,
  OPENAI_AUDIO_WIRE_API,
  probeOpenAiAudioEndpoint,
  type WireEvent,
} from '@agnes/ai'
import type {
  ConfigModel,
  ConfigSaveInput,
  ConfigTestResult,
  ModelRecord,
  RequestBody,
  RouteDecl,
} from '@agnes/protocol'
import { ConfigurationError } from './configuration-error.js'
import { normalizeConfigModel } from './configuration-models.js'

export type PayloadOnlyCapabilities = Readonly<{ payloadOnly?: boolean }>

/**
 * The config-time capability marker carried by an account's provider registry entry. Runtime
 * exclusion keeps reading the adapter registration; this only answers configuration-layer questions
 * about the entry that owns an account.
 */
export const isPayloadOnlyEntry = (entry: { api: string; capabilities?: PayloadOnlyCapabilities }): boolean =>
  entry.capabilities?.payloadOnly === true

/** A payload-only account binds an existing daemon-managed generic credential, never a raw key. */
export const GENERIC_CREDENTIAL_REF = /^secret:\/\/generic\/[a-f0-9-]{36}$/

const MAX_MODELS = 4096

export function parsePayloadOnlyCredentialRef(value: unknown): string {
  if (typeof value !== 'string' || !GENERIC_CREDENTIAL_REF.test(value))
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  return value
}

/**
 * The model list of a payload-only account. Only id, name, contextWindow, maxTokens and an optional
 * cost are editable; capability fields are fixed by the route template below, so a row that carries
 * one is refused rather than silently dropped.
 */
export function parsePayloadOnlyModels(value: unknown, api: string): ConfigModel[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODELS)
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  const models = value.map((row) => {
    const model = normalizeConfigModel(row)
    if (
      model === undefined ||
      model.contextWindow === undefined ||
      model.maxTokens === undefined ||
      model.reasoning !== undefined ||
      model.thinkingLevelMap !== undefined ||
      model.thinkingEfforts !== undefined ||
      model.defaultSettings !== undefined
    )
      throw new ConfigurationError('CONFIG_INVALID_INPUT')
    return model
  })
  if (new Set(models.map((model) => model.id)).size !== models.length)
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  // The voice role belongs to the voice adapter only, and each role serves one model.
  const roles = models.flatMap((model) => (model.audioRole ? [model.audioRole] : []))
  if (roles.length > 0 && (api !== OPENAI_AUDIO_WIRE_API || new Set(roles).size !== roles.length))
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  return models
}

type PayloadOnlyAccountRow = {
  accountId: string
  label: string
  id: string
  route: string
  baseUrl: string
  model: string
  models: ConfigModel[]
  credentialRef: string
  enabled: boolean
  authType: 'api-key'
  networkTimeouts?: ConfigSaveInput['networkTimeouts']
}

/**
 * The stored row a payload-only save produces. The account is declared, not probed: its models come
 * from the form, its credential is an existing generic credential reference, and it can never be
 * the default account. The caller still checks the referenced credential resolves.
 */
export function payloadOnlyAccountRow(args: {
  input: ConfigSaveInput
  parsed: Readonly<{ apiKey?: string; model: string; models?: unknown; credentialRef?: string }>
  entryId: string
  existing:
    | Readonly<{
        credentialRef: string
        route: string
        enabled: boolean
        networkTimeouts?: ConfigSaveInput['networkTimeouts']
      }>
    | undefined
  accountId: string
  label: string
  baseUrl: string
}): PayloadOnlyAccountRow {
  const { input, parsed, existing } = args
  if (
    input.accountId === undefined ||
    input.makeDefault === true ||
    parsed.apiKey !== undefined ||
    input.defaultSettings !== undefined
  )
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  const models = parsePayloadOnlyModels(parsed.models, getApiKeyProvider(args.entryId)?.api ?? '')
  if (!models.some((model) => model.id === parsed.model))
    throw new ConfigurationError('CONFIG_MODEL_UNAVAILABLE')
  const credentialRef =
    parsed.credentialRef === undefined
      ? existing?.credentialRef
      : parsePayloadOnlyCredentialRef(parsed.credentialRef)
  if (credentialRef === undefined) throw new ConfigurationError('CONFIG_CREDENTIAL_REQUIRED')
  const networkTimeouts =
    input.networkTimeouts === undefined ? existing?.networkTimeouts : input.networkTimeouts
  return {
    accountId: args.accountId,
    label: args.label,
    id: args.entryId,
    route: existing?.route ?? `account-${args.accountId}`,
    baseUrl: args.baseUrl,
    model: parsed.model,
    models,
    credentialRef,
    enabled: input.enabled ?? existing?.enabled ?? true,
    authType: 'api-key',
    ...(networkTimeouts === undefined ? {} : { networkTimeouts }),
  }
}

/**
 * The fixed payload-only model template: no reasoning, text input only, no tool-call formats,
 * thinking dropped on replay and no contract to carry — the fields the account form never offers.
 */
export function payloadOnlyModelRecord(
  account: Readonly<{ route: string; baseUrl: string }>,
  api: string,
  model: ConfigModel,
): ModelRecord {
  if (model.contextWindow === undefined || model.maxTokens === undefined)
    throw new ConfigurationError('CONFIG_MODEL_UNAVAILABLE')
  return {
    id: model.id,
    name: model.name,
    api,
    route: account.route,
    baseUrl: account.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    toolCallFormats: [],
    thinkingReplay: 'drop',
    contract_id: null,
    ...(model.audioRole ? { audioRole: model.audioRole } : {}),
  }
}

export function payloadOnlyRoute(
  account: Readonly<{
    route: string
    baseUrl: string
    label: string
    credentialRef: string
    model: string
    models: readonly ConfigModel[]
    networkTimeouts?: ConfigSaveInput['networkTimeouts']
  }>,
  api: string,
): RouteDecl & { models: ModelRecord[] } {
  const models = account.models.map((model) => payloadOnlyModelRecord(account, api, model))
  models.sort((a, b) => (a.id === account.model ? -1 : b.id === account.model ? 1 : 0))
  return {
    route: account.route,
    api,
    baseUrl: account.baseUrl,
    ...(account.networkTimeouts === undefined ? {} : { networkTimeouts: account.networkTimeouts }),
    credentialRef: account.credentialRef,
    displayName: account.label,
    models,
  }
}

/**
 * The api-key registry entries' capability markers keyed by wire api, in the shape
 * `payloadOnlyRoutes` asks for. The registry marker is the only capability fact the configuration
 * layer may read; runtime exclusion keeps reading the adapter registrations.
 */
export function payloadOnlyApiCapabilities(): readonly {
  id: string
  capabilities: PayloadOnlyCapabilities
}[] {
  return API_KEY_PROVIDER_REGISTRY.map((entry) => ({
    id: entry.api,
    capabilities: entry.capabilities ?? {},
  }))
}

const PROBE_TIMEOUT_MS = 30_000

export type PayloadProbeOutcome = 'ok' | 'throttled' | 'auth' | 'failed'

/**
 * One real call through the payload adapter with a fixed `{state: {}, questions: {ping}}` body: an
 * answer or a rate limit proves reachability, a rejected key is told apart, and everything else —
 * a contract mismatch, a transport failure, a timeout — is just "not reachable". The fixed body
 * carries no user data, and no reply content leaves the adapter.
 */
async function probePayloadOnlyRoute(args: {
  baseUrl: string
  model: string
  credential: string
  request: typeof globalThis.fetch
  signal: AbortSignal
}): Promise<PayloadProbeOutcome> {
  let adapter: JevAdapter
  try {
    adapter = new JevAdapter({
      routes: [{ route: 'probe', api: JEV_WIRE_API, baseUrl: args.baseUrl, models: [] }],
      network: () => ({ fetch: args.request, close: () => Promise.resolve() }),
    })
  } catch {
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  }
  try {
    adapter.bindCredential('probe', args.credential)
    const request: RequestBody = {
      kind: 'inference',
      sessionKey: 'agnes:config:probe',
      slot: 'primary',
      route: 'probe',
      model: args.model,
      contractId: null,
      derivedHash: '0'.repeat(64),
      system: '',
      messages: [],
      tools: [],
      payload: { state: {}, questions: { ping: 'ping' } },
    }
    let terminal: WireEvent | undefined
    for await (const event of adapter.stream('probe', request, {
      signal: args.signal,
      sessionKey: request.sessionKey,
      toolNames: [],
      timeoutMs: { firstToken: PROBE_TIMEOUT_MS, total: PROBE_TIMEOUT_MS },
    }))
      terminal = event
    if (terminal?.type === 'done') return 'ok'
    if (terminal?.type !== 'error') return 'failed'
    return terminal.code === 'RATE_LIMIT' ? 'throttled' : terminal.code === 'AUTH' ? 'auth' : 'failed'
  } finally {
    await adapter.dispose()
  }
}

type PayloadProbeArgs = Parameters<typeof probePayloadOnlyRoute>[0]

/**
 * The connection probe of a payload-only account, chosen by its wire api. Jev answers a fixed
 * payload; the voice adapter lists the endpoint's models, which costs nothing and needs no model.
 */
export async function probePayloadRoute(api: string, args: PayloadProbeArgs): Promise<PayloadProbeOutcome> {
  if (api === JEV_WIRE_API) return probePayloadOnlyRoute(args)
  if (api !== OPENAI_AUDIO_WIRE_API) throw new ConfigurationError('CONFIG_INVALID_INPUT')
  // The caller's signal may never abort, so the voice probe carries its own deadline like Jev's.
  const limit = new AbortController()
  const abort = () => limit.abort()
  const timer = setTimeout(abort, PROBE_TIMEOUT_MS)
  if (args.signal.aborted) abort()
  else args.signal.addEventListener('abort', abort, { once: true })
  try {
    return await probeOpenAiAudioEndpoint({
      baseUrl: args.baseUrl,
      credential: args.credential,
      request: args.request,
      signal: limit.signal,
    })
  } finally {
    clearTimeout(timer)
    args.signal.removeEventListener('abort', abort)
  }
}

/**
 * The payload-only branch of a configuration test: the account's declared models come back as they
 * are stored, and the probe runs only when a model and a resolvable generic credential are known.
 * A rejected key is the existing credential refusal; anything else unreachable stays a saveable,
 * unverified entry.
 */
export async function testPayloadOnlyAccount(
  args: {
    api: string
    baseUrl: string
    model: string | undefined
    credentialRef: string | undefined
    row: Readonly<{ model: string; models: ConfigModel[]; credentialRef: string }> | undefined
  },
  deps: {
    request: typeof globalThis.fetch
    signal: AbortSignal
    readCredential: (ref: string) => Promise<{ kind: string; provider: string; value?: string } | null>
  },
): Promise<ConfigTestResult> {
  const models = args.row?.models.map((model) => structuredClone(model)) ?? []
  const ref = args.credentialRef ?? args.row?.credentialRef
  const stored = ref === undefined ? null : await deps.readCredential(ref)
  const key =
    stored?.kind === 'api-key' &&
    stored.provider === 'generic' &&
    typeof stored.value === 'string' &&
    /\P{C}/u.test(stored.value.trim())
      ? stored.value
      : undefined
  const model = args.model ?? args.row?.model
  if (key === undefined || model === undefined) return { models, verified: false }
  const outcome = await probePayloadRoute(args.api, {
    baseUrl: args.baseUrl,
    model,
    credential: key,
    request: deps.request,
    signal: deps.signal,
  })
  if (outcome === 'auth') throw new ConfigurationError('CONFIG_CREDENTIAL_REJECTED')
  return { models, verified: outcome !== 'failed' }
}
