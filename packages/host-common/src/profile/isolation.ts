import {
  type ExtensionIsolationPolicy,
  type ExtensionIsolationRequest,
  inspectJsonData,
  validateExtensionIsolationPolicy,
  validateExtensionIsolationRequest,
} from '@agnes/protocol'
import { HostError, type Layer } from '../errors.js'
import { canonicalJson, sha256hex } from './canonical.js'
import type { ProfileInputs, ResolvedProfile } from './types.js'

const rank = { off: 0, preferred: 1, required: 2 } as const
export function mergeIsolation(
  base: ExtensionIsolationPolicy | undefined,
  next: ExtensionIsolationPolicy | ExtensionIsolationRequest | undefined,
  layer: Layer = 'user',
): ExtensionIsolationPolicy | undefined {
  if (base !== undefined) {
    const prior = validateExtensionIsolationPolicy(base)
    if (!prior.ok) throw new HostError('E_PROFILE_FRAGMENT_KEY', 'invalid prior extension isolation policy')
    base = prior.value
  }
  if (next === undefined) {
    if (base === undefined) return undefined
    next = base
    base = undefined
  }
  const checked =
    layer === 'workspace' ? validateExtensionIsolationRequest(next) : validateExtensionIsolationPolicy(next)
  if (!checked.ok)
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'invalid extension isolation policy', { source: { layer } })
  const value = checked.value,
    extensions = { ...(base?.extensions ?? {}) }
  for (const [id, mode] of Object.entries(value.extensions))
    if (rank[mode] >= rank[extensions[id] ?? 'off']) extensions[id] = mode
  const merged = {
    backend: 'backend' in value ? (value.backend ?? base?.backend ?? 'auto') : (base?.backend ?? 'auto'),
    extensions: Object.fromEntries(
      Object.entries(extensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  }
  const result = validateExtensionIsolationPolicy(merged)
  if (!result.ok)
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'merged extension isolation policy exceeds limits', {
      source: { layer },
    })
  return result.value
}
/** Until the general layers exist, only their isolation keys can be truthfully applied. */
export function isolationOnlyLayer(
  inputs: ProfileInputs,
  field: 'local' | 'flags' | 'managed',
): ExtensionIsolationPolicy | undefined {
  const input = inputs[field]
  if (input === undefined) return undefined
  const data = inspectJsonData(input, 65536)
  const value =
    data.ok && data.value && !Array.isArray(data.value) && typeof data.value === 'object'
      ? data.value
      : undefined
  const allowed = field === 'managed' ? ['version', 'policy', 'extensionIsolation'] : ['extensionIsolation']
  const validManaged =
    field !== 'managed' ||
    (value &&
      Number.isSafeInteger(value.version) &&
      Number(value.version) >= 1 &&
      value.policy !== null &&
      typeof value.policy === 'object' &&
      !Array.isArray(value.policy) &&
      Object.keys(value.policy).length === 0)
  if (
    !value ||
    !Object.hasOwn(value, 'extensionIsolation') ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    !validManaged
  )
    throw new HostError('E_DEP_MISSING', `resolveProfile cannot apply the ${field} layer yet`, {
      source: { layer: field },
      detail: { layer: field, reason: 'unimplemented' },
    })
  const checked = validateExtensionIsolationPolicy(value.extensionIsolation)
  if (!checked.ok)
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'invalid extension isolation policy', {
      source: { layer: field },
    })
  return checked.value
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
/** Legacy trusted constructor options must describe the hash actually handed to Core. */
export function withAssemblyIsolation(
  profile: ResolvedProfile,
  options: ExtensionIsolationPolicy | undefined,
): ResolvedProfile {
  if (options === undefined) return profile
  const extensionIsolation = mergeIsolation(profile.extensionIsolation, options)
  if (canonicalJson(extensionIsolation) === canonicalJson(profile.extensionIsolation)) return profile
  const { hash: _hash, ...body } = profile
  const next = JSON.parse(JSON.stringify({ ...body, extensionIsolation })) as Omit<ResolvedProfile, 'hash'>
  return freeze({ ...next, hash: `sha256-${sha256hex(canonicalJson(next))}` })
}
