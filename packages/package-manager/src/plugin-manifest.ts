export type AgnesPluginRuntime = 'in-process' | 'isolated'

/** A package author attempted to claim a row namespace owned by the daemon. */
export class ReservedPluginRowIdError extends TypeError {
  readonly reason = 'reserved-row-id'

  constructor(readonly rowId: string) {
    super(`plugin row id prefix web: is reserved; choose another id (${rowId})`)
    this.name = 'ReservedPluginRowIdError'
  }
}

export function isReservedPluginRowIdError(value: unknown): value is ReservedPluginRowIdError {
  return value instanceof ReservedPluginRowIdError
}

export interface AgnesPluginManifestEntry {
  readonly export: string
  readonly id: string
  readonly runtime: AgnesPluginRuntime
  readonly config?: unknown
  readonly default: boolean
  /** Service names the export provides. Must equal the export's own `provide` metadata: the daemon
   * builds the row without importing the module, and the mount checks the two against each other. */
  readonly provide?: readonly string[]
  /** Service names the export injects (names only; whether each is required stays in the export). */
  readonly inject?: readonly string[]
  /** Surface-callable services registered by this row; checked again at dispatch. */
  readonly services?: readonly string[]
}

const ENTRY_FIELDS = new Set([
  'export',
  'id',
  'runtime',
  'config',
  'default',
  'provide',
  'inject',
  'services',
])
const MAX_SERVICE_NAMES = 64
const MAX_SERVICE_NAME_LENGTH = 128
const ROW_ID = /^[a-z][a-z0-9-]*(?::[A-Za-z0-9@][A-Za-z0-9@._/-]{0,255})?$/

function fail(field: string, message: string): never {
  throw new TypeError(`invalid agnes.plugins ${field}: ${message}`)
}

function freezeJson(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    fail('config', 'numbers must be finite')
  }
  if (typeof value !== 'object') fail('config', 'must be JSON data')
  if (seen.has(value)) fail('config', 'cyclic values are not supported')
  seen.add(value)
  if (Array.isArray(value)) {
    const output = value.map((item) => freezeJson(item, seen))
    seen.delete(value)
    return Object.freeze(output)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail('config', 'must be JSON data')
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) fail('config', 'must use string keys')
  const output: Record<string, unknown> = Object.create(null)
  for (const [key, item] of Object.entries(value)) output[key] = freezeJson(item, seen)
  seen.delete(value)
  return Object.freeze(output)
}

/** A declared list of service names: unique, trimmed, printable, bounded. */
function serviceNames(
  index: number,
  field: 'provide' | 'inject' | 'services',
  value: unknown,
): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) fail(`entry ${index} ${field}`, 'must be an array of service names')
  if (value.length > MAX_SERVICE_NAMES) fail(`entry ${index} ${field}`, 'has too many names')
  const seen = new Set<string>()
  for (const name of value) {
    if (typeof name !== 'string' || !name.trim() || name.length > MAX_SERVICE_NAME_LENGTH)
      fail(`entry ${index} ${field}`, 'names must be non-empty strings')
    if (
      name !== name.trim() ||
      Array.from(name).some((character) => {
        const code = character.codePointAt(0) ?? 0
        return code < 32 || code === 127
      })
    )
      fail(`entry ${index} ${field}`, 'names contain unsupported characters')
    if (field === 'services' && !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/.test(name))
      fail(`entry ${index} services`, 'must use Surface service name syntax')
    if (seen.has(name)) fail(`entry ${index} ${field}`, `duplicate ${name}`)
    seen.add(name)
  }
  return Object.freeze([...value] as string[])
}

function validRowId(value: string): boolean {
  return ROW_ID.test(value) && !value.includes('/../') && !value.endsWith('/..')
}

/** Parse the sole package.json author declaration for ordinary Cordis plugins. */
export function parseAgnesPluginEntries(
  packageId: string,
  input: unknown,
): readonly Readonly<AgnesPluginManifestEntry>[] {
  if (input === undefined) return Object.freeze([])
  if (!Array.isArray(input)) fail('list', 'must be an array')
  if (input.length > 128) fail('list', 'has too many entries')

  const ids = new Set<string>()
  const entries = input.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      fail(`entry ${index}`, 'must be an object')
    const raw = value as Record<string, unknown>
    const unknown = Object.keys(raw).find((key) => !ENTRY_FIELDS.has(key))
    if (unknown) fail(`entry ${index} unknown field`, unknown)
    if (typeof raw.export !== 'string' || !raw.export.trim() || raw.export.length > 128)
      fail(`entry ${index} export`, 'must be a non-empty string')
    if (
      raw.export !== raw.export.trim() ||
      Array.from(raw.export).some((character) => {
        const code = character.codePointAt(0) ?? 0
        return code < 32 || code === 127
      })
    )
      fail(`entry ${index} export`, 'contains unsupported characters')

    const id = raw.id === undefined ? `ext:${packageId}/${raw.export}` : raw.id
    if (typeof id !== 'string' || !validRowId(id)) fail(`entry ${index} id`, 'is not a valid row id')
    if (id.startsWith('web:')) throw new ReservedPluginRowIdError(id)
    if (ids.has(id)) fail(`entry ${index} id`, `duplicate ${id}`)
    ids.add(id)

    if (raw.runtime !== undefined && raw.runtime !== 'in-process' && raw.runtime !== 'isolated')
      fail(`entry ${index} runtime`, 'must be in-process or isolated')
    const runtime: AgnesPluginRuntime = raw.runtime ?? 'in-process'
    const enabledByDefault = raw.default ?? true
    if (typeof enabledByDefault !== 'boolean') fail(`entry ${index} default`, 'must be boolean')

    return Object.freeze({
      export: raw.export,
      id,
      runtime,
      ...(raw.config === undefined ? {} : { config: freezeJson(raw.config) }),
      default: enabledByDefault,
      ...(raw.provide === undefined ? {} : { provide: serviceNames(index, 'provide', raw.provide) }),
      ...(raw.inject === undefined ? {} : { inject: serviceNames(index, 'inject', raw.inject) }),
      ...(raw.services === undefined ? {} : { services: serviceNames(index, 'services', raw.services) }),
    })
  })
  return Object.freeze(entries)
}
