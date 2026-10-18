import type { ExtensionManifest } from '@agnes/extension-api'
import { EXT_ROW_EXTENSION_IDS } from '@agnes/host-extensions/assemble/ext-rows'
import type { ExtensionSpec } from '@agnes/host-extensions/ext-host/index'
import { readAuthorManifest, readBundledExtensionDirs } from '@agnes/host-extensions/ext-host/manifest'
import type { AssemblyContext } from './context.js'
import type { ExtensionHost } from './extension-host.js'
import type { PackageSet } from './packages.js'
import type { RowHosts } from './row-hosts.js'

/**
 * Which extensions the enabled builtin packages bundle, where their manifests are, and which tool
 * names each reserves. Third-party plugin rows may have registered before the kernel existed;
 * `rowExtensions.activate` gives them their registrations now, and a tool name a builtin
 * extension declares belongs to that extension's row.
 */
export function createBundledExtensions(
  ctx: AssemblyContext,
  pkgs: PackageSet,
  host: ExtensionHost,
  rowHosts: RowHosts,
) {
  const { dirs, modules } = pkgs
  const { extPorts, extensionPlatform, dispatchExtensionShutdown } = host
  const { rowExtensions } = rowHosts
  // Builtin manifests remain descriptive input for verified Cordis rows. Packaged builds supply
  // the same manifests through embeddedExtensions when no package files exist beside the binary.
  // Builtin locations belong to this Host's deployment. Index them once rather than scanning
  // every bundled manifest for each row/tool lookup. Admission and loading still preflight the
  // selected manifest; authorManifestOf also reads it afresh, so this is not a grant cache.
  const locations = new Map<
    string,
    {
      spec: ExtensionSpec
      packageId: string
      packageDirectory: string
      extensionDirectory: string
      embedded?: ExtensionManifest
    }
  >()
  const declaredExtensionIds = new Set(EXT_ROW_EXTENSION_IDS)
  const indexLocations = () => {
    for (const pkg of ctx.profile.packages) {
      if (!pkg.enabled || pkg.trust !== 'builtin') continue
      const packageDirectory = dirs.get(pkg.id)
      if (!packageDirectory) continue
      // Source installations keep descriptive manifests beside builtin packages.
      let extensionDirs: string[]
      try {
        extensionDirs = readBundledExtensionDirs(packageDirectory, pkg.trust === 'builtin')
      } catch {
        extensionDirs = []
      }
      for (const extensionDirectory of extensionDirs) {
        let manifest: ReturnType<typeof readAuthorManifest>
        try {
          manifest = readAuthorManifest(extensionDirectory)
        } catch {
          continue
        }
        if (manifest.liveResources?.length) declaredExtensionIds.add(manifest.id)
        if (locations.has(manifest.id)) continue
        locations.set(manifest.id, {
          spec: {
            id: manifest.id,
            package: pkg.id,
            packageVersion: pkg.version,
            dir: extensionDirectory,
            trust: pkg.trust,
            enabled: true,
            integrity: pkg.integrity,
            revision: pkg.integrity,
          },
          packageId: pkg.id,
          packageDirectory,
          extensionDirectory,
        })
      }
      // Packaged builds embed the reviewed builtin manifest.
      for (const embedded of modules.get(pkg.id)?.embeddedExtensions ?? []) {
        if (embedded.liveResources?.length) declaredExtensionIds.add(embedded.id)
        if (locations.has(embedded.id)) continue
        locations.set(embedded.id, {
          spec: {
            id: embedded.id,
            package: pkg.id,
            packageVersion: pkg.version,
            dir: packageDirectory,
            trust: 'builtin',
            enabled: true,
            integrity: pkg.integrity,
            revision: pkg.integrity,
          },
          packageId: pkg.id,
          packageDirectory,
          extensionDirectory: packageDirectory,
          embedded,
        })
      }
    }
  }
  indexLocations()
  const findBundledExtension = (id: string) => locations.get(id)
  // Third-party plugin rows may have registered before the kernel existed; they get their
  // registrations now. A tool name a builtin extension declares belongs to that extension's row.
  // `'unreadable'` is a builtin whose manifest cannot be read: nothing is known about what it declares.
  const authorManifestOf = (extensionId: string) => {
    const found = findBundledExtension(extensionId)
    if (!found) return undefined
    if (found.embedded) return found.embedded
    try {
      const manifest = readAuthorManifest(found.extensionDirectory)
      return manifest.id === extensionId ? manifest : ('unreadable' as const)
    } catch {
      return 'unreadable' as const
    }
  }
  const consumesSkills = (extensionId: string) => {
    const manifest = authorManifestOf(extensionId)
    return manifest !== 'unreadable' && !!manifest?.liveResources?.includes('skills')
  }
  const reservedToolName = (name: string) => name.toLowerCase().replace(/^_+|_+$/g, '')
  const reservedTools = new Map<string, string>()
  for (const extensionId of declaredExtensionIds) {
    const manifest = authorManifestOf(extensionId)
    // An unreadable manifest declares nothing to reserve: that extension fails to load on its own.
    if (manifest === 'unreadable') continue
    for (const name of manifest?.capabilities.tools?.names ?? [])
      reservedTools.set(reservedToolName(name), `ext:${extensionId}`)
  }
  rowExtensions.activate({
    ports: extPorts,
    platform: extensionPlatform,
    shutdown: (source, context) => dispatchExtensionShutdown(source, context),
    reservedTool: (name, rowId) => {
      const owner = reservedTools.get(reservedToolName(name))
      return owner !== undefined && owner !== rowId
    },
    governance: new Map(
      ['agnes/privacy', 'agnes/hooks-runner'].map((extensionId) => {
        const manifest = authorManifestOf(extensionId)
        return [
          `ext:${extensionId}`,
          manifest === 'unreadable' ? manifest : (manifest?.capabilities.hooks ?? []),
        ] as const
      }),
    ),
  })
  return { findBundledExtension, authorManifestOf, consumesSkills, declaredExtensionIds }
}

export type BundledExtensions = ReturnType<typeof createBundledExtensions>
