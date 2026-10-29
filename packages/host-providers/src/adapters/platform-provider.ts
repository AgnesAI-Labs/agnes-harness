import type { Context } from '@agnes/cordis'
import { defineKind, type ProviderIdentity } from '@agnes/extension-api'
import { installProviderRegistry, type ProviderRegistry } from '@agnes/host-common/assemble/provider-registry'

/** The Host's own platform backend, described for the catalog. It carries no capability handle. */
export interface HostPlatformProvider extends ProviderIdentity {
  readonly os: string
}

export const HOST_PLATFORM_PROVIDER_ID = 'host'

/**
 * `platform` is Host-owned: the one implementation is registered at process start, packages can
 * neither register nor select another, and the catalog lists it read-only. The backend itself
 * stays behind `PlatformSeam` in Core.
 */
export const platformKind = defineKind<HostPlatformProvider>({
  kind: 'platform',
  authority: 'host',
  scope: 'process',
  validate(provider) {
    if (provider.id !== HOST_PLATFORM_PROVIDER_ID || typeof provider.os !== 'string' || !provider.os)
      throw new TypeError('invalid platform registration')
  },
  capabilities: (provider) => [`os:${provider.os}`],
})

export function installHostPlatform(root: Context, os: string): ProviderRegistry<HostPlatformProvider> {
  const registry = installProviderRegistry(root, platformKind)
  registry.register(
    '@agnes/host',
    Object.freeze({ id: HOST_PLATFORM_PROVIDER_ID, version: '0.0.0', os }),
    root,
  )
  return registry
}
