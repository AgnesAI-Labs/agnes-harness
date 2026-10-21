import {
  API_VERSION,
  compilePluginConfig,
  type PluginConfigContract,
  ProviderError,
  satisfiesApiRange,
} from '@agnes/extension-api'
import {
  type PluginCapabilities,
  type PluginMetadata,
  validatePackageAdminData,
  validatePluginMetadata,
} from '@agnes/protocol'

import { assertCurrentPackageFormat } from './package-format.js'

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

export interface AgnesPluginManifestEntry extends PluginConfigContract {
  readonly metadata?: PluginMetadata
  readonly export: string
  readonly id: string
  /** Required in package manifests; optional here for legacy embedding-created rows. */
  readonly apiRange?: string
  readonly runtime: AgnesPluginRuntime
  readonly config?: unknown
  readonly default: boolean
  /** Service names the export provides. Must equal the export's own `provide` metadata: the daemon
   * builds the row without importing the module, and the mount checks the two against each other. */
  readonly provide?: readonly string[]
  /**
   * Every service name the export injects. This list is the one declaration: the export carries none
   * (one that repeats it must agree). A name also listed in `optionalInject` is not waited for.
   */
  readonly inject?: readonly string[]
  /** The subset of `inject` the plugin can run without; the mount does not wait for these services. */
  readonly optionalInject?: readonly string[]
  /** Surface-callable services registered by this row; checked again at dispatch. */
  readonly services?: readonly string[]
  /** What the plugin registers and which authority it needs; one shape for every package. */
  readonly capabilities?: PluginCapabilities
  /** Bundled packages only: contributions, lease budget, live resources and supported runtimes. */
  readonly bundled?: BundledEntryFields
}

export type BundledEntryFields = Readonly<{
  contributes?: unknown
  lease?: unknown
  liveResources?: unknown
  runtimeSupports?: readonly AgnesPluginRuntime[]
}>

const BUNDLED_FIELDS = ['contributes', 'lease', 'liveResources', 'runtimeSupports'] as const
const ENTRY_FIELDS = new Set([
  'metadata',
  'export',
  'apiRange',
  'id',
  'runtime',
  'config',
  'configSchema',
  'configReload',
  'default',
  'provide',
  'inject',
  'optionalInject',
  'services',
  'capabilities',
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
  field: 'provide' | 'inject' | 'optionalInject' | 'services',
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
  options: { readonly bundled?: boolean } = {},
): readonly Readonly<AgnesPluginManifestEntry>[] {
  if (input === undefined) return Object.freeze([])
  if (!Array.isArray(input)) fail('list', 'must be an array')
  if (input.length > 128) fail('list', 'has too many entries')

  const ids = new Set<string>()
  const entries = input.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      fail(`entry ${index}`, 'must be an object')
    const raw = value as Record<string, unknown>
    const unknown = Object.keys(raw).find(
      (key) =>
        !ENTRY_FIELDS.has(key) && !(options.bundled && (BUNDLED_FIELDS as readonly string[]).includes(key)),
    )
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

    if (typeof raw.apiRange !== 'string' || !raw.apiRange.trim() || raw.apiRange.length > 256)
      throw new ProviderError('E_PROVIDER_INVALID', 'ordinary plugin requires apiRange', {
        kind: 'plugin',
        provider: packageId,
        operation: 'admit',
        hint: 'Declare a tested apiRange in every agnes.plugins entry, then reinstall or update and review trust; see docs/guide/packages.md.',
      })
    if (!satisfiesApiRange(raw.apiRange))
      throw new ProviderError(
        'E_PROVIDER_INCOMPATIBLE',
        `ordinary plugin apiRange does not admit API ${API_VERSION}`,
        {
          kind: 'plugin',
          provider: packageId,
          operation: 'admit',
          hint: 'Use a compatible extension API range or upgrade the Host.',
        },
      )

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

    if (raw.configReload !== undefined && raw.configReload !== 'live' && raw.configReload !== 'next-session')
      fail(`entry ${index} configReload`, 'must be live or next-session')
    const configSchema =
      raw.configSchema === undefined
        ? undefined
        : (freezeJson(raw.configSchema) as PluginConfigContract['configSchema'])
    if (configSchema !== undefined) {
      const validate = compilePluginConfig(configSchema)
      if (raw.config !== undefined && validate(raw.config).length)
        fail(`entry ${index} config`, 'does not satisfy configSchema (secret fields require references)')
    }
    assertCurrentPackageFormat({ metadata: raw.metadata })
    if (raw.metadata !== undefined && !validatePluginMetadata(raw.metadata).ok)
      fail(`entry ${index} metadata`, 'must satisfy the public PluginMetadata contract')
    let capabilities: PluginCapabilities | undefined
    if (raw.capabilities !== undefined) {
      const checked = validatePackageAdminData('PluginCapabilities', raw.capabilities)
      if (!checked.ok) fail(`entry ${index} capabilities`, 'must satisfy the plugin capabilities schema')
      capabilities = freezeJson(raw.capabilities) as PluginCapabilities
    }
    const runtimeSupports = raw.runtimeSupports
    if (
      runtimeSupports !== undefined &&
      (!Array.isArray(runtimeSupports) ||
        runtimeSupports.length === 0 ||
        runtimeSupports.some((value) => value !== 'in-process' && value !== 'isolated'))
    )
      fail(`entry ${index} runtimeSupports`, 'must list in-process and/or isolated')
    const bundled: BundledEntryFields | undefined = options.bundled
      ? Object.freeze({
          ...(raw.contributes === undefined ? {} : { contributes: freezeJson(raw.contributes) }),
          ...(raw.lease === undefined ? {} : { lease: freezeJson(raw.lease) }),
          ...(raw.liveResources === undefined ? {} : { liveResources: freezeJson(raw.liveResources) }),
          ...(runtimeSupports === undefined
            ? {}
            : { runtimeSupports: Object.freeze([...runtimeSupports]) as readonly AgnesPluginRuntime[] }),
        })
      : undefined
    const optionalInject =
      raw.optionalInject === undefined ? undefined : serviceNames(index, 'optionalInject', raw.optionalInject)
    if (optionalInject?.some((name) => !(raw.inject as readonly string[] | undefined)?.includes(name)))
      fail(`entry ${index} optionalInject`, 'must be a subset of inject')
    return Object.freeze({
      ...(raw.metadata === undefined ? {} : { metadata: freezeJson(raw.metadata) as PluginMetadata }),
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(bundled === undefined || Object.keys(bundled).length === 0 ? {} : { bundled }),
      export: raw.export,
      apiRange: raw.apiRange,
      id,
      runtime,
      ...(raw.config === undefined ? {} : { config: freezeJson(raw.config) }),
      ...(configSchema === undefined ? {} : { configSchema }),
      ...(raw.configReload === undefined
        ? {}
        : { configReload: raw.configReload as NonNullable<PluginConfigContract['configReload']> }),
      default: enabledByDefault,
      ...(raw.provide === undefined ? {} : { provide: serviceNames(index, 'provide', raw.provide) }),
      ...(raw.inject === undefined ? {} : { inject: serviceNames(index, 'inject', raw.inject) }),
      ...(optionalInject === undefined ? {} : { optionalInject }),
      ...(raw.services === undefined ? {} : { services: serviceNames(index, 'services', raw.services) }),
    })
  })
  return Object.freeze(entries)
}

/** Optional package-level agnes.provides declaration; absence does not imply a kind. */
export const AGNES_PLUGIN_PROVIDES = [
  'tool',
  'loop',
  'model-adapter',
  'mcp',
  'skills',
  'ui',
  'bundle',
  'service',
] as const
export type AgnesPluginProvide = (typeof AGNES_PLUGIN_PROVIDES)[number]
export function parseAgnesPluginProvides(value: unknown): readonly AgnesPluginProvide[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.length > AGNES_PLUGIN_PROVIDES.length ||
    value.some((kind) => !AGNES_PLUGIN_PROVIDES.includes(kind)) ||
    new Set(value).size !== value.length
  )
    throw new TypeError('invalid agnes.provides: expected unique supported plugin provides')
  return Object.freeze([...value]) as readonly AgnesPluginProvide[]
}

/** Validate a persisted override against the installed author contract before publication. */
export function validatePluginManifestConfig(entry: AgnesPluginManifestEntry, value: unknown) {
  return compilePluginConfig(entry.configSchema ?? true)(value)
}
