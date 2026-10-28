import type {
  AuxiliaryModelSlots,
  ConfigModel,
  ConfigSaveInput,
  ConfigTestResult,
  ModelRecord,
  RouteDecl,
  SessionDefaults,
} from '@agnes/protocol'
import { ConfigurationError } from './configuration-error.js'
import { applyModelConfiguration, normalizeConfigModel } from './configuration-models.js'
import { isPayloadOnlyEntry } from './configuration-payload-only.js'

type CompatibleEntry = Readonly<{
  id: string
  api: string
  baseUrl: string
  capabilities?: Readonly<{ declaredModels?: boolean }>
}>
type Listing =
  | Readonly<{ ids: readonly string[] }>
  | Readonly<{ failure: NonNullable<ConfigTestResult['catalogueError']> }>

/**
 * An entry for any OpenAI-compatible server at an address the person gives. Its accounts declare
 * their own models: what the endpoint lists, or ids typed by hand, never a reviewed catalogue.
 */
export const isCompatibleEntry = (entry: {
  api: string
  capabilities?: Readonly<{ declaredModels?: boolean }>
}): boolean => entry.capabilities?.declaredModels === true

/** Whether an account of this entry carries its own model list rather than a catalogue's. */
export const declaresModels = (entry: {
  api: string
  capabilities?: Readonly<{ payloadOnly?: boolean; declaredModels?: boolean }>
}): boolean => isPayloadOnlyEntry(entry) || isCompatibleEntry(entry)

/**
 * What a keyless account stores in place of a key. The wire library sends no request without one,
 * so a server that wants none is sent this, never another account's key. Listing sends nothing.
 */
export const KEYLESS_CREDENTIAL = 'no-key'

/** Capacity for a model nobody described; the account's model defaults can lower the budget. */
const CONTEXT_WINDOW = 128_000
const MAX_TOKENS = 8_192
const MAX_MODELS = 4096

const declared = (id: string): ConfigModel => ({
  id,
  name: id,
  contextWindow: CONTEXT_WINDOW,
  maxTokens: MAX_TOKENS,
})

/** The registry's stand-in address is not an address: an account has to give one. */
function requireAddress(entry: CompatibleEntry, baseUrl: string): void {
  if (baseUrl.replace(/\/$/, '') === entry.baseUrl.replace(/\/$/, ''))
    throw new ConfigurationError('CONFIG_INVALID_INPUT', undefined, undefined, 'baseUrl')
}

/**
 * The models a save declares. Capability fields are not offered for these models, so a row that
 * carries one is refused; a missing capacity takes the default.
 */
function compatibleModels(
  entry: CompatibleEntry,
  baseUrl: string,
  value: unknown,
  chatModelAllowed: (id: string) => boolean,
): ConfigModel[] {
  requireAddress(entry, baseUrl)
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODELS)
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  const models = value.map((row) => {
    const model = normalizeConfigModel(row)
    if (
      model === undefined ||
      model.reasoning !== undefined ||
      model.thinkingLevelMap !== undefined ||
      model.thinkingEfforts !== undefined ||
      model.audioRole !== undefined
    )
      throw new ConfigurationError('CONFIG_INVALID_INPUT')
    if (!chatModelAllowed(model.id)) throw new ConfigurationError('CONFIG_CHAT_MODEL_REQUIRED')
    return { ...declared(model.id), ...model }
  })
  if (new Set(models.map((model) => model.id)).size !== models.length)
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  return models
}

/**
 * Lists what the endpoint offers, with the given key, the saved one, or none. Every listed id is
 * offered unless it is a known generation model; a listing that fails is not an error but an unverified result that says why, so the
 * models can still be typed by hand.
 */
async function testCompatibleAccount(
  args: {
    entry: CompatibleEntry
    baseUrl: string
    apiKey: string | undefined
    row: Readonly<{ models: ConfigModel[]; credentialRef: string }> | undefined
  },
  deps: {
    chatModelAllowed: (id: string) => boolean
    list: (api: string, baseUrl: string, credential: string | undefined) => Promise<Listing>
    readCredential: (ref: string) => Promise<{ kind: string; provider: string; value?: string } | null>
  },
): Promise<ConfigTestResult> {
  const { entry, row } = args
  requireAddress(entry, args.baseUrl)
  const stored = row && args.apiKey === undefined ? await deps.readCredential(row.credentialRef) : null
  const saved =
    stored?.kind === 'api-key' && stored.provider === entry.id && stored.value !== KEYLESS_CREDENTIAL
      ? stored.value
      : undefined
  const listing = await deps.list(entry.api, args.baseUrl, args.apiKey ?? saved)
  if ('failure' in listing) return { models: [], verified: false, catalogueError: listing.failure }
  return {
    models: listing.ids
      .filter(deps.chatModelAllowed)
      .map((id) => structuredClone(row?.models.find((m) => m.id === id)) ?? declared(id)),
    verified: true,
  }
}

/** A declared model as a chat record: text in, native tool calls, no reasoning to replay. */
function compatibleModelRecord(
  account: Readonly<{ route: string; baseUrl: string }>,
  api: string,
  model: ConfigModel,
): ModelRecord {
  const record: ModelRecord = {
    id: model.id,
    name: model.name,
    api,
    route: account.route,
    baseUrl: account.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? MAX_TOKENS,
    toolCallFormats: ['native'],
    thinkingReplay: 'drop',
    contract_id: null,
  }
  return applyModelConfiguration(record, model)
}

function compatibleRoute(
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
  chatModelAllowed: (id: string) => boolean,
): RouteDecl & { models: ModelRecord[] } {
  if (!chatModelAllowed(account.model)) throw new ConfigurationError('CONFIG_CHAT_MODEL_REQUIRED')
  const models = account.models
    .filter((model) => chatModelAllowed(model.id))
    .map((model) => compatibleModelRecord(account, api, model))
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

/** Bind the adapter-owned conversation policy at the existing configuration assembly boundary. */
export function chatModelPolicy(chatModelAllowed: (id: string) => boolean) {
  const requireModel = (id: string, payloadOnly = false): void => {
    if (!payloadOnly && !chatModelAllowed(id)) throw new ConfigurationError('CONFIG_CHAT_MODEL_REQUIRED')
  }
  return {
    requireModel,
    models: (models: readonly ConfigModel[], payloadOnly: boolean): ConfigModel[] =>
      models
        .filter((model) => payloadOnly || chatModelAllowed(model.id))
        .map((model) => structuredClone(model)),
    requireSlots(slots: AuxiliaryModelSlots): void {
      for (const slot of Object.values(slots)) if (slot) requireModel(slot.model)
    },
    defaults(defaults: SessionDefaults | undefined): SessionDefaults | undefined {
      if (defaults?.model) requireModel(defaults.model)
      return defaults
    },
    compatibleModels: (entry: CompatibleEntry, baseUrl: string, value: unknown) =>
      compatibleModels(entry, baseUrl, value, chatModelAllowed),
    testCompatibleAccount: (
      args: Parameters<typeof testCompatibleAccount>[0],
      deps: Omit<Parameters<typeof testCompatibleAccount>[1], 'chatModelAllowed'>,
    ) => testCompatibleAccount(args, { ...deps, chatModelAllowed }),
    compatibleRoute: (account: Parameters<typeof compatibleRoute>[0], api: string) =>
      compatibleRoute(account, api, chatModelAllowed),
  }
}
