import type { ConfigModel, ModelRecord, ModelSettings } from '@agnes/protocol'

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

/** Installed capabilities remain authoritative; saved deployment overrides and defaults survive re-testing. */
export function configModel(record: ModelRecord, saved?: ConfigModel): ConfigModel {
  const effective = applyModelConfiguration(record, saved)
  return {
    id: effective.id,
    name: effective.name,
    reasoning: effective.reasoning,
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
    ...(saved?.defaultSettings === undefined ? {} : { defaultSettings: saved.defaultSettings }),
  }
}
