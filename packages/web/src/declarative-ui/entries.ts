import { type PluginUiEntriesResult, type PluginUiEntry, validatePackageAdminCall } from '@agnes/protocol'
import { createExternalStore } from '@agnes/web-ui'

export const PLUGIN_UI_ENTRIES_METHOD = '_agnes/v1/clientModules.uiEntries'
export type PluginUiCard = PluginUiEntry & { key: string; testId: string }
type Surface = 'settings' | 'sidebar'
type Selection = { entry: PluginUiCard; trigger: HTMLElement | undefined }
export type PluginUiConfigurationLease = {
  entry: PluginUiCard
  target: Pick<PluginUiEntry, 'packageId' | 'rowId' | 'integrity'> & { profile: string }
  isCurrent(): boolean
}
type Snapshot = Readonly<{
  entries: readonly PluginUiCard[]
  sidebar?: Selection
  settings?: Selection
}>

function isProjection(value: unknown): value is PluginUiEntriesResult {
  return validatePackageAdminCall(PLUGIN_UI_ENTRIES_METHOD, 'result', value).ok
}

function observations(entries: readonly PluginUiEntry[], previous: readonly PluginUiCard[]) {
  const prior = new Map(previous.map((entry) => [entry.key, entry]))
  const keyed = entries.map((entry) => ({
    entry,
    key: JSON.stringify([entry.packageId, entry.rowId, entry.integrity, entry.id, entry.placement]),
  }))
  const retained = new Set(keyed.flatMap(({ key }) => prior.get(key)?.testId ?? []))
  return keyed.map(({ entry, key }) => {
    const existing = prior.get(key)
    if (existing) return existing
    const base = `declarative-ui-${entry.placement.replace('.', '-')}-${entry.id}`
    const testId = retained.has(base) ? `${base}:${key}` : base
    retained.add(testId)
    return { ...entry, key, testId }
  })
}

export function createPluginUiEntries() {
  const store = createExternalStore<Snapshot>({ entries: [] })
  let profile = ''
  let online = false
  let epoch = 0
  const isCurrent = (entry: PluginUiCard) => store.getSnapshot().entries.includes(entry)
  const replace = (entries: readonly PluginUiCard[]) => {
    const { entries: prior, sidebar, settings } = store.getSnapshot()
    if (entries.length === prior.length && entries.every((entry, index) => entry === prior[index])) return
    store.set({
      entries,
      ...(sidebar && entries.includes(sidebar.entry) ? { sidebar } : {}),
      ...(settings && entries.includes(settings.entry) ? { settings } : {}),
    })
  }
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    isCurrent,
    setScope(connected: boolean, nextProfile: string) {
      if (connected === online && nextProfile === profile) return
      online = connected
      profile = nextProfile
      epoch++
      replace([])
    },
    packageChanged(packageId: string | undefined) {
      epoch++
      if (packageId !== undefined)
        replace(store.getSnapshot().entries.filter((entry) => entry.packageId !== packageId))
    },
    async refresh(read: (profile: string) => Promise<unknown>) {
      if (!online || !profile) return
      const ticket = ++epoch
      let result: unknown
      try {
        result = await read(profile)
      } catch {
        if (ticket === epoch) replace([])
        return
      }
      if (ticket !== epoch) return
      replace(isProjection(result) ? observations(result.entries, store.getSnapshot().entries) : [])
    },
    open(surface: Surface, entry: PluginUiCard, trigger?: HTMLElement) {
      if (entry.placement !== surface || !isCurrent(entry)) return
      store.set({ ...store.getSnapshot(), [surface]: { entry, trigger } })
    },
    close(surface: Surface) {
      const { entries, settings, sidebar } = store.getSnapshot()
      if (surface === 'settings' && settings) store.set({ entries, ...(sidebar ? { sidebar } : {}) })
      if (surface === 'sidebar' && sidebar) store.set({ entries, ...(settings ? { settings } : {}) })
    },
    configuration(entry: PluginUiCard): PluginUiConfigurationLease | undefined {
      if (!online || !profile || !entry.configure || !isCurrent(entry)) return
      const target = { profile, packageId: entry.packageId, rowId: entry.rowId, integrity: entry.integrity }
      return { entry, target, isCurrent: () => isCurrent(entry) }
    },
  }
}

type PluginUiDocument = {
  entries: ReturnType<typeof createPluginUiEntries>
  configuration: ReturnType<typeof createExternalStore<PluginUiConfigurationLease | undefined>>
  requestConfiguration?: ((entry: PluginUiCard, showing: () => boolean) => Promise<boolean>) | undefined
}

// The host app and the shipped presentation renderer are separate bundles in the same document.
const pluginUiKey = Symbol.for('agnes.web.declarativePluginUi')
const documentScope = globalThis as { [pluginUiKey]?: PluginUiDocument }
documentScope[pluginUiKey] ??= {
  entries: createPluginUiEntries(),
  configuration: createExternalStore<PluginUiConfigurationLease | undefined>(undefined),
}
export const pluginUiDocument = documentScope[pluginUiKey]
export const pluginUiEntries = pluginUiDocument.entries
