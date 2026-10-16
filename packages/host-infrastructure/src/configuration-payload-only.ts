import type { ConfigModel, ConfigSaveInput, ModelRecord, RouteDecl } from '@agnes/protocol'
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
export function parsePayloadOnlyModels(value: unknown): ConfigModel[] {
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
  return models
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
