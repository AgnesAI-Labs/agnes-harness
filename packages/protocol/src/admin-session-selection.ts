/** Host catalogs contain descriptions, never factories or credentials. */
export type AdminLoop = Readonly<{
  id: string
  version: string
  label?: string
  capabilities: readonly string[]
  sourcePackage: string
}>
export type AdminModelAdapter = Readonly<{
  id: string
  version: string
  /** Wire API may differ from the registered adapter identity. */
  wireApi: string
  sourcePackage: string
  capabilities: Readonly<{
    imageInput: boolean
    tools: boolean
    streaming: boolean
    /** The adapter reads a request's `payload`. */
    payload?: boolean
    /** The adapter takes a request's `payload` instead of its messages; it also declares `payload`. */
    payloadOnly?: boolean
  }>
  label?: string
  models: readonly Readonly<{ id: string; label?: string; route?: string }>[]
}>
/** Admin defaults select providers in the same `providers.<kind>` table as every other artifact. */
export type SessionDefaults = Readonly<{
  preset?: string
  /** The permission level new sessions start under when the request names none. */
  permission?: 'read-only' | 'workspace-write' | 'full-access'
  providers?: Readonly<{
    loop?: Readonly<{ provider: string; version: string }>
    'model-adapter'?: Readonly<{ provider: string; version: string }>
  }>
  /** The model served by `providers.model-adapter`; only valid beside it. */
  model?: string
}>
/** The default loop as the exact identity the Host and Web carry. */
export const defaultLoop = (defaults: SessionDefaults): { id: string; version: string } | undefined => {
  const loop = defaults.providers?.loop
  return loop ? { id: loop.provider, version: loop.version } : undefined
}
/** The default model adapter and its model as one identity, when both are chosen. */
export const defaultModelAdapter = (
  defaults: SessionDefaults,
): { id: string; version: string; model: string } | undefined => {
  const adapter = defaults.providers?.['model-adapter']
  return adapter && defaults.model
    ? { id: adapter.provider, version: adapter.version, model: defaults.model }
    : undefined
}
export type SessionDefaultsSnapshot = Readonly<{
  revision: number
  defaults: SessionDefaults
}>
export type SessionDefaultsUpdate = SessionDefaultsSnapshot
export interface AdminSessionCatalog {
  presets?(): Promise<readonly string[]>
  permissions?(): Promise<readonly string[]>
  loops(): Promise<readonly AdminLoop[]>
  modelAdapters(): Promise<readonly AdminModelAdapter[]>
}
export interface AdminSessionSelection extends AdminSessionCatalog {
  getDefaults(): Promise<SessionDefaultsSnapshot>
  saveDefaults(input: SessionDefaultsUpdate): Promise<SessionDefaultsSnapshot>
}

const PERMISSION_LEVELS = ['read-only', 'workspace-write', 'full-access'] as const
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  Array.from(value).every((character) => {
    const code = character.codePointAt(0) ?? 0
    return code >= 32 && code !== 127
  })
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key))

export function isSessionDefaults(value: unknown): value is SessionDefaults {
  if (!record(value) || !keys(value, ['preset', 'permission', 'providers', 'model'])) return false
  const { preset, permission, providers, model } = value
  if (preset !== undefined && !text(preset)) return false
  if (permission !== undefined && !PERMISSION_LEVELS.includes(permission as never)) return false
  if (model !== undefined && !text(model)) return false
  if (providers === undefined) return model === undefined
  if (!record(providers) || !keys(providers, ['loop', 'model-adapter'])) return false
  const selection = (item: unknown) =>
    item === undefined ||
    (record(item) && keys(item, ['provider', 'version']) && text(item.provider) && text(item.version))
  return (
    selection(providers.loop) &&
    selection(providers['model-adapter']) &&
    (model === undefined) === (providers['model-adapter'] === undefined)
  )
}
export function isSessionDefaultsSnapshot(value: unknown): value is SessionDefaultsSnapshot {
  return (
    record(value) &&
    keys(value, ['revision', 'defaults']) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    isSessionDefaults(value.defaults)
  )
}
export function isAdminLoop(value: unknown): value is AdminLoop {
  return (
    record(value) &&
    keys(value, ['id', 'version', 'label', 'capabilities', 'sourcePackage']) &&
    text(value.id) &&
    text(value.version) &&
    (value.label === undefined || text(value.label)) &&
    text(value.sourcePackage) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length <= 128 &&
    value.capabilities.every(text)
  )
}
export function isAdminModelAdapter(value: unknown): value is AdminModelAdapter {
  if (
    !record(value) ||
    !keys(value, ['id', 'version', 'wireApi', 'sourcePackage', 'capabilities', 'label', 'models']) ||
    !text(value.id) ||
    !text(value.version) ||
    !text(value.wireApi) ||
    !text(value.sourcePackage) ||
    (value.label !== undefined && !text(value.label)) ||
    !Array.isArray(value.models) ||
    value.models.length > 4096 ||
    !record(value.capabilities) ||
    !keys(value.capabilities, ['imageInput', 'tools', 'streaming', 'payload', 'payloadOnly']) ||
    typeof value.capabilities.imageInput !== 'boolean' ||
    typeof value.capabilities.tools !== 'boolean' ||
    typeof value.capabilities.streaming !== 'boolean' ||
    (value.capabilities.payload !== undefined && typeof value.capabilities.payload !== 'boolean') ||
    (value.capabilities.payloadOnly !== undefined && typeof value.capabilities.payloadOnly !== 'boolean')
  )
    return false
  return value.models.every(
    (model) =>
      record(model) &&
      keys(model, ['id', 'label', 'route']) &&
      text(model.id) &&
      (model.label === undefined || text(model.label)) &&
      (model.route === undefined || text(model.route)),
  )
}
