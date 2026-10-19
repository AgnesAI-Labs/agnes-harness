import {
  bundledExampleSource,
  bundledPluginSource,
  OPTIONAL_BUNDLED_PACKAGES,
  type PackageSource,
} from '@agnes/package-manager'
import type { PackageInstalledDescriptor } from '@agnes/protocol'

export function packageOrigin(
  source: PackageSource,
  provenance?: PackageInstalledDescriptor['provenance'],
  builtin = false,
): NonNullable<NonNullable<PackageInstalledDescriptor['presentation']>['origin']> {
  if (builtin || bundledPluginSource(source.ref) || provenance?.verification === 'official-ed25519')
    return 'official'
  if (bundledExampleSource(source.ref)) return 'example'
  if (provenance?.authoring) return 'local'
  return ['file', 'local', 'workspace', 'path'].includes(source.type) ? 'local-source' : 'third-party'
}

/** Shipped but chosen by the user: marked so the UI offers uninstall, unlike the default-enabled helpers. */
export function optionalBundled(source: PackageSource): { optional: true } | Record<string, never> {
  return OPTIONAL_BUNDLED_PACKAGES.some((item) => item.ref === source.ref) ? { optional: true } : {}
}
