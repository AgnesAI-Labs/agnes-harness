import { checkManifest, type ExtensionManifest } from '@agnes/extension-api'
import { PackageError } from './errors.js'

/** Shared by package trust and extension loading; never infer grants from truthy prefixes. */
export function manifestCapabilities(manifest: ExtensionManifest): string[] {
  const checked = checkManifest(manifest)
  if (!checked.ok) throw new PackageError('E_EXT_LOAD', 'invalid extension manifest')
  const c = checked.value.capabilities
  return [
    ...(c.tools ? ['tools'] : []),
    ...(['hooks', 'slots', 'resources', 'services', 'projections', 'ui'] as const).filter(
      (key) => c[key]?.length,
    ),
    ...(c.network && !Array.isArray(c.network) && c.network.hosts.length ? ['network'] : []),
    ...(c['network.publicRead'] === true ? ['network.publicRead'] : []),
    ...(['events', 'tools.invoke', 'artifacts', 'subagent'] as const).filter((key) => c[key] === true),
  ]
}

export function assertCapabilityCeiling(manifest: ExtensionManifest, ceiling: readonly string[]): void {
  const missing = manifestCapabilities(manifest).filter((name) => !ceiling.includes(name))
  if (missing.length)
    throw new PackageError('E_CEILING_EXCEEDED', 'extension exceeds capability ceiling', {
      detail: { missing },
    })
}
