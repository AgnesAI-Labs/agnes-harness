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
/** What the injected known-model table says about an id; the table itself lives in the AI package. */
type KnownLimits = Readonly<{ contextWindow: number; maxTokens: number; thinkingReplay: 'native' }>
type KnownModels = (id: string) => KnownLimits | undefined
type Listing =
  | Readonly<{
      ids: readonly string[]
      contextWindows?: Readonly<Record<string, number>>
      maxTokens?: Readonly<Record<string, number>>
    }>
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

const declared = (id: string, knownModel: KnownModels): ConfigModel => {
  const known = knownModel(id)
  return {
    id,
    name: id,
    contextWindow: known?.contextWindow ?? CONTEXT_WINDOW,
    maxTokens: known?.maxTokens ?? MAX_TOKENS,
  }
}

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
  knownModel: KnownModels,
  selection?: Pick<ConfigSaveInput, 'model' | 'defaultSettings'>,
): ConfigModel[] {
  requireAddress(entry, baseUrl)
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODELS)
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  const models = value.map((row) => {
    const candidate =
      row !== null &&
      typeof row === 'object' &&
      !Array.isArray(row) &&
      'id' in row &&
      selection !== undefined &&
      row.id === selection.model &&
      selection.defaultSettings !== undefined
        ? { ...row, defaultSettings: selection.defaultSettings }
        : row
    const model = normalizeConfigModel(candidate)
    if (
      model === undefined ||
      model.reasoning !== undefined ||
      model.thinkingLevelMap !== undefined ||
      model.thinkingEfforts !== undefined ||
      model.audioRole !== undefined
    )
      throw new ConfigurationError('CONFIG_INVALID_INPUT')
    if (!chatModelAllowed(model.id)) throw new ConfigurationError('CONFIG_CHAT_MODEL_REQUIRED')
    return { ...declared(model.id, knownModel), ...model }
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
    knownModel: KnownModels
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
  const contexts = new Map(Object.entries(listing.contextWindows ?? {}))
  const outputs = new Map(Object.entries(listing.maxTokens ?? {}))
  return {
    models: listing.ids.filter(deps.chatModelAllowed).map((id) => {
      const contextWindow = contexts.get(id)
      const maxTokens = outputs.get(id)
      return {
        ...(structuredClone(row?.models.find((m) => m.id === id)) ?? declared(id, deps.knownModel)),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      }
    }),
    verified: true,
  }
}

/**
 * A declared model as a chat record: text in, native tool calls. A model the known-model table
 * describes (DeepSeek V4) replays its reasoning signature and takes the table's limits unless the
 * person gave their own; any other model has the default capacity and drops reasoning. Reasoning
 * stays false for every record: a declared model has no thinking-level map, so with
 * `reasoning: true` pi-ai would send thinking as disabled on DeepSeek's API and switch the system
 * prompt to the `developer` role on unknown gateways. Replay needs neither.
 */
function compatibleModelRecord(
  account: Readonly<{ route: string; baseUrl: string }>,
  api: string,
  model: ConfigModel,
  knownModel: KnownModels,
): ModelRecord {
  const known = knownModel(model.id)
  const record: ModelRecord = {
    id: model.id,
    name: model.name,
    api,
    route: account.route,
    baseUrl: account.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? known?.contextWindow ?? CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? known?.maxTokens ?? MAX_TOKENS,
    toolCallFormats: ['native'],
    thinkingReplay: known?.thinkingReplay ?? 'drop',
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
  knownModel: KnownModels,
): RouteDecl & { models: ModelRecord[] } {
  if (!chatModelAllowed(account.model)) throw new ConfigurationError('CONFIG_CHAT_MODEL_REQUIRED')
  const models = account.models
    .filter((model) => chatModelAllowed(model.id))
    .map((model) => compatibleModelRecord(account, api, model, knownModel))
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
export function chatModelPolicy(chatModelAllowed: (id: string) => boolean, knownModel: KnownModels) {
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
    compatibleModels: (
      entry: CompatibleEntry,
      baseUrl: string,
      value: unknown,
      selection?: Pick<ConfigSaveInput, 'model' | 'defaultSettings'>,
    ) => compatibleModels(entry, baseUrl, value, chatModelAllowed, knownModel, selection),
    testCompatibleAccount: (
      args: Parameters<typeof testCompatibleAccount>[0],
      deps: Omit<Parameters<typeof testCompatibleAccount>[1], 'chatModelAllowed' | 'knownModel'>,
    ) => testCompatibleAccount(args, { ...deps, chatModelAllowed, knownModel }),
    compatibleRoute: (account: Parameters<typeof compatibleRoute>[0], api: string) =>
      compatibleRoute(account, api, chatModelAllowed, knownModel),
  }
}
