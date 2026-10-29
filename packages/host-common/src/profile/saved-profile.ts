import { HostError } from '../errors.js'
import { isPermission } from '../presets/permission.js'
import type { ResolvedProfile } from './types.js'

const map = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

function fail(message: string): never {
  throw new HostError('E_PRESET_UNSUPPORTED', `saved profile: ${message}`)
}

/**
 * Decodes the profile snapshot a session binding carries: every top-level field the Host
 * reads when it reopens the session, with the element shape of the lists it iterates.
 */
export function checkSavedProfile(value: unknown): ResolvedProfile {
  if (!map(value)) fail('must be an object')
  if (typeof value.name !== 'string' || !value.name) fail('invalid name')
  if (typeof value.schemaVersion !== 'number') fail('invalid schemaVersion')
  if (!strings(value.chain)) fail('invalid chain')
  if (!Array.isArray(value.packages)) fail('invalid packages')
  for (const pkg of value.packages)
    if (
      !map(pkg) ||
      typeof pkg.id !== 'string' ||
      typeof pkg.version !== 'string' ||
      typeof pkg.source !== 'string' ||
      typeof pkg.integrity !== 'string' ||
      (pkg.trust !== 'builtin' && pkg.trust !== 'trusted') ||
      typeof pkg.enabled !== 'boolean' ||
      (pkg.config !== undefined && !map(pkg.config)) ||
      (pkg.provides !== undefined && !strings(pkg.provides))
    )
      fail('invalid package row')
  if (!map(value.seams)) fail('invalid seams')
  for (const [name, seam] of Object.entries(value.seams)) if (!map(seam)) fail(`invalid seam ${name}`)
  const provider = value.provider
  if (!map(provider) || typeof provider.package !== 'string' || !strings(provider.adapters))
    fail('invalid provider')
  if (provider.routes !== undefined && !Array.isArray(provider.routes)) fail('invalid provider routes')
  const adapters = value.adapters
  if (
    !map(adapters) ||
    !['storage', 'fs', 'exec', 'platform'].every((key) => typeof adapters[key] === 'string') ||
    !map(adapters.secrets)
  )
    fail('invalid adapters')
  if (!Array.isArray(value.transports) || !value.transports.every(map)) fail('invalid transports')
  if (typeof value.dataDir !== 'string' || typeof value.cacheDir !== 'string') fail('invalid directories')
  if (!map(value.limits) || !Object.values(value.limits).every((limit) => typeof limit === 'number'))
    fail('invalid limits')
  const presets = value.presets
  if (!map(presets) || typeof presets.default !== 'string' || !strings(presets.allowed))
    fail('invalid presets')
  const permissions = value.permissions
  if (
    permissions !== undefined &&
    (!map(permissions) || !isPermission(permissions.default) || !Array.isArray(permissions.allowed))
  )
    fail('invalid permissions')
  const policy = value.policy
  if (!map(policy) || !strings(policy.capabilityCeiling)) fail('invalid policy')
  for (const key of ['reconcile', 'approvals', 'computerUse'] as const)
    if (!map(value[key])) fail(`invalid ${key}`)
  if (!strings(value.runtimes)) fail('invalid runtimes')
  if (typeof value.hash !== 'string') fail('invalid hash')
  if (value.bundles !== undefined && !strings(value.bundles)) fail('invalid bundles')
  return value as ResolvedProfile
}
