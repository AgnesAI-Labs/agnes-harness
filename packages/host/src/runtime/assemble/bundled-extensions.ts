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
  // Builtin package layout is fixed for this assembly. Index it once instead of walking every
  // bundled manifest again for each row, admission check and factory lookup (quadratic on disk).
  const bundledDirectories = new Map<string, Map<string, string>>()
  const directoriesFor = (packageDirectory: string) => {
    const existing = bundledDirectories.get(packageDirectory)
    if (existing) return existing
    const indexed = new Map<string, string>()
    try {
      for (const directory of readBundledExtensionDirs(packageDirectory, true)) {
        try {
          const manifest = readAuthorManifest(directory)
          if (!indexed.has(manifest.id)) indexed.set(manifest.id, directory)
        } catch {
          // An unreadable extension cannot claim an id; its admission remains fail-closed.
        }
      }
    } catch {
      // Packaged installations can supply embedded manifests without source directories.
    }
    bundledDirectories.set(packageDirectory, indexed)
    return indexed
  }
  // Builtin manifests remain descriptive input for verified Cordis rows. Packaged builds supply
  // the same manifests through embeddedExtensions when no package files exist beside the binary.
  const findBundledExtension = (
    id: string,
  ):
    | {
        spec: ExtensionSpec
        packageId: string
        packageDirectory: string
        extensionDirectory: string
        embedded?: ExtensionManifest
      }
    | undefined => {
    for (const pkg of ctx.profile.packages) {
      if (!pkg.enabled || pkg.trust !== 'builtin') continue
      const packageDirectory = dirs.get(pkg.id)
      if (!packageDirectory) continue
      // Source installations keep descriptive manifests beside builtin packages.
      const extensionDirectory = directoriesFor(packageDirectory).get(id)
      if (extensionDirectory) {
        return {
          spec: {
            id,
            package: pkg.id,
            packageVersion: pkg.version,
            dir: extensionDirectory,
            trust: pkg.trust,
            enabled: true,
            integrity: pkgs.grants.integrity(pkg.id) ?? pkg.integrity,
            revision: pkgs.grants.integrity(pkg.id) ?? pkg.integrity,
          },
          packageId: pkg.id,
          packageDirectory,
          extensionDirectory,
        }
      }
      // Packaged builds embed the reviewed builtin manifest.
      const embedded = modules.get(pkg.id)?.embeddedExtensions?.find((m) => m.id === id)
      if (embedded && pkg.trust === 'builtin')
        return {
          spec: {
            id: embedded.id,
            package: pkg.id,
            packageVersion: pkg.version,
            dir: packageDirectory,
            trust: 'builtin',
            enabled: true,
            integrity: pkgs.grants.integrity(pkg.id) ?? pkg.integrity,
            revision: pkgs.grants.integrity(pkg.id) ?? pkg.integrity,
          },
          packageId: pkg.id,
          packageDirectory,
          extensionDirectory: packageDirectory,
          embedded,
        }
    }
    return undefined
  }
  // Third-party plugin rows may have registered before the kernel existed; they get their
  // registrations now. A tool name a builtin extension declares belongs to that extension's row.
  // `'unreadable'` is a builtin whose manifest cannot be read: nothing is known about what it declares.
  const authorManifestOf = (extensionId: string) => {
    const found = findBundledExtension(extensionId)
    if (!found) return undefined
    if (found.embedded) return found.embedded
    try {
      return readAuthorManifest(found.extensionDirectory)
    } catch {
      return 'unreadable' as const
    }
  }
  const consumesSkills = (extensionId: string) => {
    const manifest = authorManifestOf(extensionId)
    return manifest !== 'unreadable' && !!manifest?.liveResources?.includes('skills')
  }
  // A replacement bundled extension can declare the same public resource contract under any id.
  const declaredExtensionIds = new Set(EXT_ROW_EXTENSION_IDS)
  for (const pkg of ctx.profile.packages) {
    if (!pkg.enabled || pkg.trust !== 'builtin') continue
    for (const manifest of modules.get(pkg.id)?.embeddedExtensions ?? [])
      if (manifest.liveResources?.length) declaredExtensionIds.add(manifest.id)
    const directory = dirs.get(pkg.id)
    if (!directory) continue
    try {
      for (const extensionDirectory of directoriesFor(directory).values()) {
        const manifest = readAuthorManifest(extensionDirectory)
        if (manifest.liveResources?.length) declaredExtensionIds.add(manifest.id)
      }
    } catch {
      /* Admission below remains fail-closed for unreadable manifests. */
    }
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
      pkgs.grants.governance().map((extensionId) => {
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
