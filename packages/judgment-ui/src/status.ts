/** A bounded browser contract, deliberately independent of runtime implementation modules. */
export type JudgmentUseStatus = Readonly<{
  enabled: boolean
  available: boolean
  reason: 'none' | 'disabled' | 'native-required' | 'model-unavailable' | 'authorization-unavailable'
  requests: number
}>
export type JudgmentStatus = Readonly<{
  version: 1
  /** SHA-256 of the active instance configuration, not a persisted host revision. */
  configurationRevision: string
  state: 'ready' | 'unconfigured' | 'unavailable'
  reason:
    | 'none'
    | 'model-not-configured'
    | 'model-unavailable'
    | 'ambiguous-model'
    | 'authorization-unavailable'
  hookTimeout: 'unknown'
  cache: Readonly<{ hit: number; miss: number; size: number }>
  uses: Readonly<Record<'stop' | 'findRelevant' | 'judgeBatch' | 'rules', JudgmentUseStatus>>
}>

function fields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}
function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function useStatus(value: unknown): value is JudgmentUseStatus {
  return (
    fields(value, ['enabled', 'available', 'reason', 'requests']) &&
    typeof value.enabled === 'boolean' &&
    typeof value.available === 'boolean' &&
    typeof value.reason === 'string' &&
    ['none', 'disabled', 'native-required', 'model-unavailable', 'authorization-unavailable'].includes(
      value.reason,
    ) &&
    counter(value.requests)
  )
}
export function parseJudgmentStatus(value: unknown): JudgmentStatus | null {
  if (
    !fields(value, ['version', 'configurationRevision', 'state', 'reason', 'hookTimeout', 'cache', 'uses']) ||
    value.version !== 1 ||
    typeof value.configurationRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.configurationRevision) ||
    typeof value.state !== 'string' ||
    !['ready', 'unconfigured', 'unavailable'].includes(value.state) ||
    typeof value.reason !== 'string' ||
    ![
      'none',
      'model-not-configured',
      'model-unavailable',
      'ambiguous-model',
      'authorization-unavailable',
    ].includes(value.reason) ||
    value.hookTimeout !== 'unknown' ||
    !fields(value.cache, ['hit', 'miss', 'size']) ||
    !counter(value.cache.hit) ||
    !counter(value.cache.miss) ||
    !counter(value.cache.size) ||
    value.cache.size > 2000 ||
    !fields(value.uses, ['stop', 'findRelevant', 'judgeBatch', 'rules']) ||
    !Object.values(value.uses).every(useStatus)
  )
    return null
  return value as JudgmentStatus
}
