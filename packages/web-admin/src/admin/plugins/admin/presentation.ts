import type {
  CompositionCapabilitySnapshot,
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  RuntimeAdminSnapshot,
} from '@agnes/protocol'
import type { PluginPresentation, PluginProvidedItem, PluginSurface } from '@agnes/web-ui'

type PackageItem = PackageInstalledDescriptor | PackageCatalogDescriptor
const providerSurfaces: Readonly<Record<string, readonly PluginSurface[]>> = {
  loop: ['chat', 'background'],
  'tool-policy': ['approval', 'background'],
  compaction: ['background'],
  memory: ['chat', 'background'],
  'model-adapter': ['chat'],
  'child-agent': ['background'],
  persistence: ['background'],
  sandbox: ['background'],
  'reference-resolver': ['chat'],
  'webhook-trigger': ['background'],
  'tool-runtime': ['background'],
  'observability-exporter': ['background'],
  'feedback-service': ['settings'],
  'intelligent-ui': ['chat', 'workbench'],
}
function slotSurface(slot: string): PluginSurface {
  if (slot.startsWith('settings.')) return 'settings'
  if (slot.includes('approval')) return 'approval'
  if (slot.startsWith('workbench.') || slot.startsWith('rightbar') || slot.startsWith('sidebar.right.'))
    return 'workbench'
  return 'chat'
}

/** A small read-only projection of today's catalogs, not a new runtime authority. */
export function pluginPresentation(
  item: PackageItem,
  input: {
    runtime?: RuntimeAdminSnapshot | undefined
    composition?: CompositionCapabilitySnapshot | undefined
    slots?: readonly string[] | undefined
    surfaces?: readonly { surfaceId: string }[] | undefined
  } = {},
): PluginPresentation {
  const provides = new Map<string, PluginProvidedItem>()
  const appearsIn = new Set<PluginSurface>()
  const add = (entry: PluginProvidedItem, surfaces: readonly PluginSurface[] = []) => {
    provides.set(`${entry.kind}:${entry.id}`, entry)
    for (const surface of surfaces) appearsIn.add(surface)
  }
  // Catalog entries describe versions available for installation, not loaded registrations.
  const installed = 'desired' in item
  const current =
    installed &&
    item.actual === 'running' &&
    (!item.actualIntegrity || item.actualIntegrity === item.integrity)
  if (current) {
    for (const provider of input.runtime?.providers ?? []) {
      if (provider.sourcePackage !== item.id) continue
      add(
        {
          kind: provider.kind,
          id: provider.id,
          selected: provider.active,
          ...(provider.scope ? { scope: provider.scope } : {}),
        },
        providerSurfaces[provider.kind],
      )
    }
    for (const bundle of input.runtime?.bundles ?? []) {
      if (bundle.sourcePackage === item.id) add({ kind: 'bundle', id: bundle.id }, ['chat'])
    }
    for (const session of input.composition?.status === 'live' ? input.composition.sessions : []) {
      const pinned = session.capabilities?.codePin.packages.find((pkg) => pkg.id === item.id)
      if (pinned?.integrity && pinned.integrity !== item.integrity) continue
      if (pinned?.version && pinned.version !== item.version) continue
      for (const group of session.toolGroups ?? []) {
        if (
          group.packageId !== item.id &&
          !item.presentation?.rows.some((row) => row.source === group.packageId)
        )
          continue
        for (const id of group.tools) add({ kind: 'tool', id }, ['chat'])
      }
    }
  }
  if (installed) {
    for (const slot of input.slots ?? []) {
      const surface = slotSurface(slot)
      add({ kind: surface === 'settings' ? 'settings' : 'panel', id: slot }, [surface])
    }
    for (const surface of input.surfaces ?? []) add({ kind: 'surface', id: surface.surfaceId }, ['page'])
    // This is configuration support from a real schema, not a registered custom settings page.
    for (const row of item.presentation?.rows ?? []) {
      if (row.settings) add({ kind: 'settings', id: row.id }, ['settings'])
    }
    // Inventory has verified packaged resource/UI descriptors; tool capability names are not used.
    for (const contribution of item.contributions) {
      if (contribution.kind === 'skill') add({ kind: 'skill', id: contribution.id }, ['chat'])
      if ('skins' in contribution)
        for (const skin of contribution.skins ?? [])
          add({ kind: 'skin', id: skin.id }, ['settings', 'application'])
    }
  }
  return {
    provides: [...provides.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
    appearsIn: [...appearsIn],
    available:
      !!provides.size || (current && input.runtime !== undefined && input.composition?.status === 'live'),
  }
}

export function matchesPluginSearch(
  item: PackageItem,
  query: string,
  value?: PluginPresentation,
  provideLabel?: (kind: string) => string,
): boolean {
  const metadata = item.metadata
  const text = [
    item.id,
    item.version,
    metadata?.displayName,
    metadata?.summary,
    ...Object.values(metadata?.locales ?? {}).flatMap((locale) => [locale.displayName, locale.summary]),
    ...item.contributions.map((entry) => entry.id),
    ...(item.presentation?.rows ?? []).flatMap((row) => [
      row.id,
      row.metadata?.displayName,
      row.metadata?.summary,
      ...Object.values(row.metadata?.locales ?? {}).flatMap((locale) => [locale.displayName, locale.summary]),
    ]),
    ...(value?.provides ?? []).flatMap((entry) => [entry.kind, entry.id, provideLabel?.(entry.kind)]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
  return text.includes(query.trim().toLocaleLowerCase())
}
