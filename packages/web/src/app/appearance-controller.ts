import type { LocaleService } from '@agnes/web-client'
import { applicationIdentity, effectiveApplication } from '@agnes/web-client'
import { bindAppearance, bindSkinGroup } from '@agnes/web-foundation/appearance'
import {
  applyDocumentLocale,
  readLocalePreference,
  writeLocalePreference,
} from '@agnes/web-foundation/locale-preference'
import {
  cacheSkinEntry,
  clearSkinCache,
  fetchSkinCss,
  planSkinReconcile,
  readSkinCache,
  SKIN_PREFERENCE_KEY,
  SKIN_STORAGE_KEY,
  type SkinRosterEntry,
  skinOverride,
} from '@agnes/web-foundation/skin'
import { safeThemeStorage } from '@agnes/web-foundation/theme'
import { updateApplicationTitle } from '../application.js'
import { broadcast, onBroadcast, onPageHide, onWindowFocus } from './global-events.js'

type SkinRoster = {
  revision: string
  skins: readonly {
    id: string
    name: string
    packageName: string
    cssUrl: string
    css?: string
    tokens?: SkinRosterEntry['tokens']
  }[]
}

/**
 * Theme, language and skin preferences of this document.
 *
 * The skin manifest uses the profile reported by `config.get()`. The daemon accepts only its own profile,
 * so pass it back here; client parameters cannot select a directory.
 */
export function createAppearanceController(options: {
  locale: LocaleService
  /** Empty until the daemon has reported its profile. */
  profile: () => string
  listSkins: (profile: string) => Promise<SkinRoster>
}) {
  const storage = safeThemeStorage(window)
  const appearance = bindAppearance({
    scope: document,
    root: document.documentElement,
    storage,
    locale: {
      rendered: true,
      current: () => readLocalePreference(storage),
      select: (value) => {
        writeLocalePreference(storage, value)
        applyDocumentLocale(document.documentElement, value)
        options.locale.setLocale(value)
        updateApplicationTitle()
        broadcast('agnes:locale-changed', value)
      },
      text: (key) => options.locale.t(key),
    },
  })
  /** Most recently fetched manifest, used for selected CSS and tokens; replace it entirely when it changes. */
  let roster: SkinRosterEntry[] = []
  /** Same-origin fetcher for the `cssUrl` fallback; accept only `/skins/` paths (see `fetchSkinCss`). */
  const cssOptions = { fetcher: (input: string) => fetch(input), origin: location.origin }
  /** Increment on every explicit selection so in-flight reconciliation cannot overwrite the user's latest choice. */
  let selection = 0
  let disposed = false

  const readSkinPreference = (): string | null => {
    try {
      return storage.getItem(SKIN_PREFERENCE_KEY)
    } catch {
      return null
    }
  }

  /** Notify first-frame logic and other same-origin documents that the cached skin changed; dispatch manually because storage events skip this document. */
  const skinChanged = (): void => {
    window.dispatchEvent(new StorageEvent('storage', { key: SKIN_STORAGE_KEY }))
  }

  /**
   * Reconcile the cache after receiving a new manifest.
   *
   * Skins whose source was uninstalled/disabled must **stop coloring the page**. If only the digest changes,
   * replace the cache without flicker. Fall back to the built-in appearance only while fetching new text;
   * that temporary flicker is accepted.
   */
  async function reconcile(entries: readonly SkinRosterEntry[]): Promise<void> {
    if (disposed) return
    const plan = planSkinReconcile(readSkinCache(storage), entries, readSkinPreference())
    if (plan.kind === 'keep') return
    const version = selection
    if (plan.kind === 'clear') {
      clearSkinCache(storage)
      skinChanged()
      return
    }
    if (plan.entry.css !== undefined) {
      await cacheSkinEntry(storage, plan.entry, cssOptions)
      skinChanged()
      return
    }
    clearSkinCache(storage)
    skinChanged()
    try {
      const css = await fetchSkinCss(plan.entry.cssUrl, cssOptions)
      // The user may have changed selection while text was fetched: discard reconciliation rather than restoring the old skin.
      if (disposed || version !== selection) return
      await cacheSkinEntry(storage, { ...plan.entry, css }, cssOptions)
      skinChanged()
    } catch {
      // On fetch failure keep the built-in appearance instead of writing a partial cache.
    }
  }

  let skinEpoch = 0
  let skinIdentity = ''
  const publishApplicationSkin = (detail: unknown) =>
    window.dispatchEvent(new CustomEvent('agnes:application-skin', { detail }))
  const updateApplicationSkin = (): void => {
    const override = skinOverride(location.search)
    const application = effectiveApplication()
    const identity = applicationIdentity.getSnapshot()
    const selected = roster.find((skin) =>
      override !== null
        ? skin.id === override
        : skin.id === application?.presentation?.skin && skin.packageName === identity?.selection?.packageId,
    )
    const next = JSON.stringify([
      selected,
      override === null ? [identity?.selection?.packageId, identity?.selection?.consentDigest] : override,
    ])
    if (next === skinIdentity) return
    skinIdentity = next
    const epoch = ++skinEpoch
    // Revoke the previous application synchronously, before any fetch or observer can yield.
    publishApplicationSkin(null)
    if (!selected || disposed) return
    const publish = (css: string) => {
      if (disposed || epoch !== skinEpoch) return
      publishApplicationSkin({
        version: 1,
        id: selected.id,
        revision: selected.revision,
        css,
        tokens: selected.tokens,
      })
    }
    if (selected.css !== undefined) publish(selected.css)
    else
      void fetchSkinCss(selected.cssUrl, cssOptions)
        .then(publish)
        .catch(() => undefined)
  }

  const skins = bindSkinGroup({
    scope: document,
    storage,
    list: async () => {
      const profile = options.profile()
      if (profile === '') return []
      const listed = await options.listSkins(profile)
      if (disposed) return roster
      roster = listed.skins.map((skin) => ({
        id: skin.id,
        name: skin.name,
        packageName: skin.packageName,
        revision: listed.revision,
        cssUrl: skin.cssUrl,
        ...(skin.css === undefined ? {} : { css: skin.css }),
        tokens: skin.tokens ?? {},
      }))
      // Reconcile only after receiving a manifest: `[]` here would mean all skins were uninstalled and erase the selection.
      await reconcile(roster)
      updateApplicationSkin()
      return roster
    },
    select: async (id) => {
      // Record selection first: fetching CSS awaits, and in-flight reconciliation must not restore the old skin in that gap.
      selection += 1
      if (id === null) clearSkinCache(storage)
      else {
        const chosen = roster.find((skin) => skin.id === id)
        // Missing from the manifest means it just changed: throw so the group restores the old choice rather than a false selection.
        if (chosen === undefined) throw new Error(`skin ${id} is not in the current roster`)
        // If not inlined, fetch text before caching; otherwise an empty cached stylesheet would make selection have no effect.
        await cacheSkinEntry(storage, chosen, cssOptions)
      }
      storage.setItem(SKIN_PREFERENCE_KEY, id ?? 'none')
      skinChanged()
    },
  })
  const stopApplication = applicationIdentity.subscribe(updateApplicationSkin)
  updateApplicationSkin()
  const stopPackages = onBroadcast('agnes:packages-changed', () => void skins.refresh())
  // A cold daemon can initially report no active backend rows. Re-read after its
  // authoritative tree/package notice, just as the client module roster does.
  const stopRuntime = onBroadcast('agnes:plugins-invalidated', () => void skins.refresh())
  const stopFocus = onWindowFocus(() => void skins.refresh())
  onPageHide(() => {
    disposed = true
    stopApplication()
    skinEpoch += 1
    publishApplicationSkin(null)
    stopPackages()
    stopRuntime()
    stopFocus()
    selection += 1
  })
  return { appearance, skins }
}
