import type { ConfigModel, ModelRecord, ModelSettings } from '@agnes/protocol'
import { ConfigurationError } from './configuration-error.js'

const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function normalizeModelSettings(value: unknown): ModelSettings | undefined {
  if (!object(value) || Object.keys(value).some((key) => !['thinking', 'contextWindow'].includes(key)))
    return undefined
  if ('thinking' in value && (typeof value.thinking !== 'string' || !levels.has(value.thinking)))
    return undefined
  if (
    'contextWindow' in value &&
    (!Number.isSafeInteger(value.contextWindow) || (value.contextWindow as number) < 1)
  )
    return undefined
  return { ...value } as ModelSettings
}

/** Decode both legacy model rows and the current capability/default projection. */
export function normalizeConfigModel(value: unknown): ConfigModel | undefined {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'id',
          'name',
          'thinkingEfforts',
          'reasoning',
          'thinkingLevelMap',
          'contextWindow',
          'maxTokens',
          'cost',
          'defaultSettings',
          'audioRole',
          'input',
        ].includes(key),
    )
  )
    return undefined
  if (typeof value.id !== 'string' || !/^[^\p{Cc}\p{Z}\s]{1,256}$/u.test(value.id)) return undefined
  if (
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    value.name.length > 256 ||
    /\p{Cc}/u.test(value.name)
  )
    return undefined
  const map = (v: unknown) =>
    object(v) &&
    Object.keys(v).length > 0 &&
    Object.entries(v).every(
      ([key, wire]) => levels.has(key) && typeof wire === 'string' && wire.trim().length > 0,
    )
  if ('thinkingEfforts' in value && value.thinkingEfforts !== false && !map(value.thinkingEfforts))
    return undefined
  if ('thinkingLevelMap' in value && !map(value.thinkingLevelMap)) return undefined
  if (
    'input' in value &&
    (!Array.isArray(value.input) ||
      value.input.length === 0 ||
      new Set(value.input).size !== value.input.length ||
      value.input.some((one) => one !== 'text' && one !== 'image'))
  )
    return undefined
  if ('reasoning' in value && typeof value.reasoning !== 'boolean') return undefined
  if (
    'contextWindow' in value &&
    (!Number.isSafeInteger(value.contextWindow) || (value.contextWindow as number) < 1)
  )
    return undefined
  if ('maxTokens' in value && (!Number.isSafeInteger(value.maxTokens) || (value.maxTokens as number) < 1))
    return undefined
  if (
    'cost' in value &&
    (!object(value.cost) ||
      Object.keys(value.cost).length !== 4 ||
      !['input', 'output', 'cacheRead', 'cacheWrite'].every(
        (key) =>
          typeof (value.cost as Record<string, unknown>)[key] === 'number' &&
          Number.isFinite((value.cost as Record<string, unknown>)[key] as number),
      ))
  )
    return undefined
  if ('audioRole' in value && value.audioRole !== 'transcribe' && value.audioRole !== 'speech')
    return undefined
  if ('defaultSettings' in value && normalizeModelSettings(value.defaultSettings) === undefined)
    return undefined
  const model = structuredClone(value) as ConfigModel
  if (model.defaultSettings && !supportsModelSettings(model, model.defaultSettings)) return undefined
  return model
}

export function supportsModelSettings(
  model: Pick<ConfigModel, 'reasoning' | 'thinkingLevelMap' | 'thinkingEfforts' | 'contextWindow'>,
  settings: ModelSettings,
): boolean {
  const reasoning = model.thinkingEfforts === false ? false : model.thinkingEfforts ? true : model.reasoning
  const map = model.thinkingEfforts || model.thinkingLevelMap
  return (
    (settings.thinking === undefined ||
      (reasoning === true && (!map || Object.hasOwn(map, settings.thinking)))) &&
    (settings.contextWindow === undefined ||
      model.contextWindow === undefined ||
      settings.contextWindow <= model.contextWindow)
  )
}

/** Catalogue defaults and saved input declarations are projected together when re-testing. */
export function configModel(record: ModelRecord, saved?: ConfigModel): ConfigModel {
  const effective = applyModelConfiguration(record, saved)
  return {
    id: effective.id,
    name: effective.name,
    reasoning: effective.reasoning,
    input: [...effective.input],
    ...(effective.thinkingLevelMap ? { thinkingLevelMap: effective.thinkingLevelMap } : {}),
    contextWindow: effective.contextWindow,
    ...(saved?.thinkingEfforts === undefined ? {} : { thinkingEfforts: saved.thinkingEfforts }),
    ...(saved?.defaultSettings === undefined ? {} : { defaultSettings: saved.defaultSettings }),
  }
}

/** Project an installed catalogue while retaining each model's saved configuration. */
export function configModels(
  records: readonly ModelRecord[],
  saved: readonly ConfigModel[] = [],
): ConfigModel[] {
  return records.map((record) =>
    configModel(
      record,
      saved.find((model) => model.id === record.id),
    ),
  )
}

export function applyModelConfiguration(record: ModelRecord, saved?: ConfigModel): ModelRecord {
  let effective = record
  if (saved?.thinkingEfforts === false) {
    const { thinkingLevelMap: _drop, ...rest } = record
    effective = { ...rest, reasoning: false }
  } else if (saved?.thinkingEfforts)
    effective = { ...record, reasoning: true, thinkingLevelMap: saved.thinkingEfforts }
  return {
    ...effective,
    ...(saved?.input === undefined ? {} : { input: [...saved.input] }),
    ...(saved?.defaultSettings === undefined ? {} : { defaultSettings: saved.defaultSettings }),
  }
}

/** Catalogue accounts may customize input types, never introduce models or change other capabilities. */
export function applyInputOverrides(models: ConfigModel[], value: unknown): ConfigModel[] {
  if (value === undefined) return models
  if (!Array.isArray(value) || value.length === 0 || value.length > 4096)
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  const declarations = value.map(normalizeConfigModel)
  if (
    declarations.some((m) => !m?.input || !models.some((base) => base.id === m.id)) ||
    declarations.some((m) => m && Object.keys(m).some((k) => !['id', 'name', 'input'].includes(k))) ||
    new Set(declarations.map((m) => m?.id)).size !== declarations.length
  )
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  return models.map((m) => {
    const input = declarations.find((d) => d?.id === m.id)?.input
    return input ? { ...m, input: [...input] } : m
  })
}

/**
 * The input types an account's models start with, before the person changes them. An endpoint at a
 * built-in provider's exact address and protocol takes that provider's catalogue. Any other endpoint,
 * such as a gateway like llm.sg whose model list names models but not what they accept, takes for
 * each id the built-in catalogues know what they agree on: an id two catalogues describe differently
 * keeps only the types both allow. An id no catalogue knows keeps the text fallback.
 */
export async function catalogueInputs<T extends { api: string; baseUrl: string; capabilities?: unknown }>(
  providers: readonly T[],
  read: (provider: T) => Promise<{ records: ModelRecord[] }>,
  api: string,
  address: string,
): Promise<ReadonlyMap<string, ModelRecord['input']>> {
  const catalogued = providers.filter((candidate) => !candidate.capabilities)
  const records = (provider: T) =>
    read(provider).then(
      (catalogue) => catalogue.records,
      () => [] as ModelRecord[],
    )
  const exact = catalogued.find(
    (candidate) =>
      candidate.api === api && candidate.baseUrl.replace(/\/$/, '') === address.replace(/\/$/, ''),
  )
  if (exact) return new Map((await records(exact)).map((record) => [record.id, record.input]))
  const agreed = new Map<string, ModelRecord['input']>()
  for (const catalogue of await Promise.all(catalogued.map(records)))
    for (const record of catalogue) {
      const prior = agreed.get(record.id)
      agreed.set(
        record.id,
        prior
          ? (prior.filter((type) => record.input.includes(type)) as ModelRecord['input'])
          : [...record.input],
      )
    }
  for (const [id, input] of agreed) if (input.length === 0) agreed.delete(id)
  return agreed
}
