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
  api: string
  sourcePackage: string
  capabilities: Readonly<{ imageInput: boolean; tools: boolean; streaming: boolean }>
  label?: string
  models: readonly Readonly<{ id: string; label?: string }>[]
}>
export type SessionDefaults = Readonly<{
  loop?: Readonly<{ id: string; version: string }>
  modelAdapter?: Readonly<{ id: string; version: string; model: string }>
}>
export type SessionDefaultsSnapshot = Readonly<{
  revision: number
  defaults: SessionDefaults
}>
export type SessionDefaultsUpdate = SessionDefaultsSnapshot
export interface AdminSessionCatalog {
  loops(): Promise<readonly AdminLoop[]>
  modelAdapters(): Promise<readonly AdminModelAdapter[]>
}
export interface AdminSessionSelection extends AdminSessionCatalog {
  getDefaults(): Promise<SessionDefaultsSnapshot>
  saveDefaults(input: SessionDefaultsUpdate): Promise<SessionDefaultsSnapshot>
}

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
  if (!record(value) || !keys(value, ['loop', 'modelAdapter'])) return false
  const { loop, modelAdapter } = value
  return (
    (loop === undefined ||
      (record(loop) && keys(loop, ['id', 'version']) && text(loop.id) && text(loop.version))) &&
    (modelAdapter === undefined ||
      (record(modelAdapter) &&
        keys(modelAdapter, ['id', 'version', 'model']) &&
        text(modelAdapter.id) &&
        text(modelAdapter.version) &&
        text(modelAdapter.model)))
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
    !keys(value, ['id', 'version', 'api', 'sourcePackage', 'capabilities', 'label', 'models']) ||
    !text(value.id) ||
    !text(value.version) ||
    !text(value.api) ||
    !text(value.sourcePackage) ||
    (value.label !== undefined && !text(value.label)) ||
    !Array.isArray(value.models) ||
    value.models.length > 4096 ||
    !record(value.capabilities) ||
    !keys(value.capabilities, ['imageInput', 'tools', 'streaming']) ||
    typeof value.capabilities.imageInput !== 'boolean' ||
    typeof value.capabilities.tools !== 'boolean' ||
    typeof value.capabilities.streaming !== 'boolean'
  )
    return false
  return value.models.every(
    (model) =>
      record(model) &&
      keys(model, ['id', 'label']) &&
      text(model.id) &&
      (model.label === undefined || text(model.label)),
  )
}
