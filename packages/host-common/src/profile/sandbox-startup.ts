import { RELEASE_DEFAULTS } from '@agnes/package-manager'

import { HostError } from '../errors.js'

export const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/

/** `providers.sandbox` with the `sandbox.options` of the profile. An omitted provider means the local host sandbox. */
export function readSandboxStartupConfig(
  value: unknown,
): Readonly<{ provider: string; options?: Readonly<Record<string, string>> }> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'sandbox must be a mapping', {
      detail: { field: 'sandbox' },
    })
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'provider' && key !== 'options')
      throw new HostError('E_PROFILE_FRAGMENT_KEY', `sandbox.${key} is not a startup field`, {
        detail: { field: `sandbox.${key}` },
      })
  }
  if (
    record.options !== undefined &&
    (record.options === null ||
      typeof record.options !== 'object' ||
      Array.isArray(record.options) ||
      Object.values(record.options).some((value) => typeof value !== 'string'))
  )
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'sandbox.options must be a mapping of strings')
  if (record.provider === undefined && record.options === undefined) return undefined
  const provider = record.provider ?? RELEASE_DEFAULTS.sandboxProvider
  if (typeof provider !== 'string' || !PROVIDER_ID.test(provider))
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'providers.sandbox.provider must be a provider id', {
      detail: { field: 'providers.sandbox.provider' },
    })
  return Object.freeze({
    provider,
    ...(record.options ? { options: Object.freeze({ ...(record.options as Record<string, string>) }) } : {}),
  })
}

export function sandboxProviderIdFrom(
  config: { sandbox?: { provider?: string; options?: Readonly<Record<string, string>> } } | undefined,
): string {
  const id = config?.sandbox?.provider
  return id === undefined || id === '' ? RELEASE_DEFAULTS.sandboxProvider : id
}
