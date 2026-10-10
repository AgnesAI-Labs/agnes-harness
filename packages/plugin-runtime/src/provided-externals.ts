import * as cordis from '@agnes/cordis'
import * as extensionApi from '@agnes/extension-api'
import { API_VERSION, ProviderError, satisfiesApiRange } from '@agnes/extension-api'
import * as typebox from '@sinclair/typebox'
import * as typeboxCompiler from '@sinclair/typebox/compiler'
import * as typeboxValue from '@sinclair/typebox/value'
import * as author from './index.js'
import * as deferredContract from './deferred-contract.js'

/** Public author namespaces only: never expose plugin-runtime/host or testkit. */
export const providedExternalModules = Object.freeze({
  '@agnes/plugin-runtime': author,
  '@agnes/plugin-runtime/deferred-contract': deferredContract,
  '@agnes/extension-api': extensionApi,
  '@agnes/cordis': cordis,
  '@sinclair/typebox': typebox,
  '@sinclair/typebox/value': typeboxValue,
  '@sinclair/typebox/compiler': typeboxCompiler,
})

/** Release pins; ranges use the same syntax as extension apiRange. */
export const providedExternalVersions: Readonly<Record<string, string>> = Object.freeze({
  '@agnes/plugin-runtime': '0.0.0',
  '@agnes/plugin-runtime/deferred-contract': '0.0.0',
  '@agnes/extension-api': API_VERSION,
  '@agnes/cordis': '0.0.0',
  '@agnes/protocol': '0.0.0',
  '@agnes/intelligent-ui-contract': '0.0.0',
  '@sinclair/typebox': '0.34.33',
  '@sinclair/typebox/value': '0.34.33',
  '@sinclair/typebox/compiler': '0.34.33',
})

export class PluginModuleError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly module?: string,
  ) {
    super(message)
    this.name = 'PluginModuleError'
  }
}

/** Optional package.json agnes.hostProvidedExternals: module specifier -> version range. */
export function checkProvidedExternals(value: unknown): void {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PluginModuleError(
      'external-manifest',
      'agnes.hostProvidedExternals must map public modules to version ranges',
    )
  for (const [name, range] of Object.entries(value)) {
    // Never echo arbitrary manifest text or evaluation errors.
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/.test(name) || name.length > 214)
      throw new PluginModuleError(
        'external-manifest',
        'hostProvidedExternals contains an invalid module name',
      )
    const version = Object.hasOwn(providedExternalVersions, name) ? providedExternalVersions[name] : undefined
    if (!version)
      throw new PluginModuleError(
        'external-unavailable',
        `Host does not provide module "${name}"; bundle it or install it as a plugin dependency.`,
        name,
      )
    if (typeof range !== 'string' || !satisfiesApiRange(range, version))
      throw new PluginModuleError(
        'external-version',
        `Host module "${name}" is version ${version}, incompatible with the declared range; use a compatible SDK range or upgrade AGH.`,
        name,
      )
  }
}

/** Extract only a bounded module specifier from Node/jiti resolver failures. */
export function missingPluginModule(error: unknown): PluginModuleError | undefined {
  if (!error || typeof error !== 'object') return undefined
  const failure = error as { code?: unknown; message?: unknown }
  if (
    !['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(String(failure.code)) ||
    typeof failure.message !== 'string'
  )
    return undefined
  const name = /^Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(failure.message)?.[1]
  if (!name || name.length > 214 || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/.test(name))
    return undefined
  return new PluginModuleError(
    'module-missing',
    `Missing plugin module "${name}"; declare compatible agnes.hostProvidedExternals for public SDK modules, or bundle/install this third-party dependency in the plugin package.`,
    name,
  )
}

/** Called on static metadata before any ordinary plugin module is evaluated. */
export function checkPluginApiRanges(plugins: unknown, packageId: string): void {
  if (plugins === undefined) return
  if (!Array.isArray(plugins))
    throw new ProviderError('E_PROVIDER_INVALID', 'agnes.plugins must be an array', {
      kind: 'plugin',
      provider: packageId,
      operation: 'admit',
    })
  for (const plugin of plugins) {
    const range = plugin && typeof plugin === 'object' ? plugin.apiRange : undefined
    if (typeof range !== 'string' || !range.trim() || range.length > 256)
      throw new ProviderError('E_PROVIDER_INVALID', 'ordinary plugin requires apiRange', {
        kind: 'plugin',
        provider: packageId,
        operation: 'admit',
        hint: 'Declare apiRange in every agnes.plugins entry.',
      })
    if (!satisfiesApiRange(range))
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
  }
}
