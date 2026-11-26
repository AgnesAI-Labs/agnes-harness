import { type SkinChoice, type SkinListResult, validatePackageAdminCall } from '@agnes/protocol'
import { applicationIdentity, type LocaleService } from '@agnes/web-client'
import { bindAppearance, bindSkinGroup, type SkinGroupView } from '@agnes/web-foundation/appearance'
import {
  applyDocumentLocale,
  readLocalePreference,
  writeLocalePreference,
} from '@agnes/web-foundation/locale-preference'
import {
  applySkinTokens,
  SKIN_PREFERENCE_KEY,
  type SkinSheetState,
  syncSkinSheet,
} from '@agnes/web-foundation/skin'
import {
  readThemePreference,
  resolveTheme,
  safeThemeStorage,
  systemPrefersDark,
  THEME_STORAGE_KEY,
  watchSystemTheme,
} from '@agnes/web-foundation/theme'
import { updateApplicationTitle } from '../application.js'
import { backendResourceUrl, selectedRemoteOrigin } from '../remote-frontend.js'
import { broadcast, onBroadcast, onPageHide, onWindowFocus } from './global-events.js'

type SelectedSkin = NonNullable<SkinListResult['selected']>

/** Constructed sheets resolve relative URLs against the document, not the original stylesheet. */
function bindAssetUrls({ css, cssUrl, id }: SelectedSkin): string {
  const base = cssUrl.slice(0, -'skin.css'.length)
  const stylesheet = new URL(cssUrl, location.origin)
  const authorBase = `/skins/${id}/`
  const remote = selectedRemoteOrigin()
  return css.replace(
    /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi,
    (whole: string, _quote: string, reference: string) => {
      const value = reference.trim()
      if (!value || value.startsWith('#')) return whole
      let url: URL
      try {
        url = new URL(value, stylesheet)
      } catch {
        return whole
      }
      if (!url.pathname.startsWith('/skins/'))
        return /^(?:\/|[a-zA-Z][a-zA-Z0-9+.-]*:)/u.test(value) ? whole : 'url("")'
      if (url.origin !== location.origin && url.origin !== remote) return 'url("")'
      const path = url.pathname.startsWith(base)
        ? url.pathname
        : url.pathname.startsWith(authorBase)
          ? `${base}${url.pathname.slice(authorBase.length)}`
          : ''
      if (!path.startsWith(`${base}assets/`)) return 'url("")'
      // Always use the chosen backend's transport. Never leave a legacy or local same-ID URL behind.
      return `url(${JSON.stringify(backendResourceUrl(`${path}${url.search}${url.hash}`, remote))})`
    },
  )
}

export function createAppearanceController(options: {
  locale: LocaleService
  /** Empty until the current connection has a daemon-reported profile. */
  profile(): string
  backendIdentity(): string
  listSkins(profile: string): Promise<unknown>
  selectSkin(
    profile: string,
    revision: number,
    choice: SkinChoice,
    isCurrent: () => boolean,
  ): Promise<unknown>
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
  let roster: SkinListResult | undefined
  let disposed = false
  let epoch = 0
  let skin: { css: string; tokens: NonNullable<SelectedSkin['tokens']> } | null = null
  let sheet: SkinSheetState = { sheet: undefined, css: undefined }
  let written: ReadonlySet<string> = new Set()

  const paintSkin = () => {
    const root = document.documentElement
    const mode = resolveTheme(readThemePreference(storage), systemPrefersDark(window))
    if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
      try {
        sheet = syncSkinSheet(document, sheet, skin?.css ?? '', () => new CSSStyleSheet())
      } catch {
        skin = null
        sheet = syncSkinSheet(document, sheet, '', () => new CSSStyleSheet())
      }
    }
    written = applySkinTokens(root, skin, mode, written)
    broadcast('agnes:skin-painted')
  }

  const invalidate = () => {
    epoch += 1
    roster = undefined
    if (skin !== null) {
      skin = null
      paintSkin()
    }
  }
  const canRender = !new URLSearchParams(location.search).has('admin')
  const group = bindSkinGroup({
    scope: document,
    list: async (): Promise<SkinGroupView> => {
      invalidate()
      const token = epoch
      const profile = options.profile()
      const backend = options.backendIdentity()
      if (!profile || !canRender || disposed) throw new Error('Skin roster is unavailable')
      const raw = await options.listSkins(profile)
      if (
        disposed ||
        token !== epoch ||
        profile !== options.profile() ||
        backend !== options.backendIdentity()
      )
        throw new Error('Skin roster changed')
      const checked = validatePackageAdminCall('_agnes/v1/skins.list', 'result', raw)
      if (!checked.ok) throw new Error('Skin roster is invalid')
      const listed = checked.value as SkinListResult
      if (listed.profile !== profile) throw new Error('Skin roster belongs to another profile')
      const { selected, choice } = listed
      if (
        selected &&
        (selected.cssUrl !== `/skins/${selected.bindingDigest}/${selected.id}/skin.css` ||
          !listed.skins.some(
            ({ id, bindingDigest }) => id === selected.id && bindingDigest === selected.bindingDigest,
          ) ||
          (selected.kind === 'manual'
            ? choice.kind !== 'skin' || choice.bindingDigest !== selected.bindingDigest
            : choice.kind !== 'application'))
      )
        throw new Error('Selected skin is invalid')
      roster = listed
      let legacyNone = false
      try {
        legacyNone = listed.revision === 0 && storage.getItem(SKIN_PREFERENCE_KEY) === 'none'
      } catch {
        // The obsolete preference can only suppress a skin.
      }
      if (selected && !legacyNone && new URLSearchParams(location.search).get('skin') !== 'none') {
        skin = { css: bindAssetUrls(selected), tokens: selected.tokens ?? {} }
        paintSkin()
      }
      return {
        selected:
          choice.kind === 'skin' && selected
            ? selected.bindingDigest
            : choice.kind === 'none' || choice.kind === 'skin'
              ? ''
              : 'application',
        skins: listed.skins.map(({ bindingDigest, name, packageId, version }) => ({
          value: bindingDigest,
          name,
          packageName: packageId,
          version,
        })),
        unavailable: choice.kind === 'skin' && selected === null,
      }
    },
    select: async (value) => {
      const listed = roster
      if (!listed || !canRender || disposed || listed.profile !== options.profile())
        throw new Error('Skin list changed')
      const backend = options.backendIdentity()
      const choice: SkinChoice =
        value === ''
          ? { kind: 'none' }
          : value === 'application'
            ? { kind: 'application' }
            : { kind: 'skin', bindingDigest: value }
      invalidate()
      const token = epoch
      await options.selectSkin(
        listed.profile,
        listed.revision,
        choice,
        () =>
          !disposed &&
          token === epoch &&
          options.profile() === listed.profile &&
          options.backendIdentity() === backend,
      )
    },
  })
  const refresh = () => {
    invalidate()
    return group.refresh()
  }
  const applicationKey = () => {
    const current = applicationIdentity.getSnapshot()
    return JSON.stringify([current?.revision, current?.status, current?.selection?.adoptionGeneration])
  }
  let application = applicationKey()
  const stopApplication = applicationIdentity.subscribe(() => {
    const next = applicationKey()
    if (next === application) return
    application = next
    void refresh()
  })
  const stopPackages = onBroadcast('agnes:packages-changed', () => void refresh())
  const stopRuntime = onBroadcast('agnes:plugins-invalidated', () => void refresh())
  const stopFocus = onWindowFocus(() => void refresh())
  const stopTheme = onBroadcast('agnes:theme-changed', paintSkin)
  const stopSystem = watchSystemTheme(window, paintSkin)
  const storageChanged = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) paintSkin()
  }
  window.addEventListener('storage', storageChanged)
  onPageHide(() => {
    disposed = true
    invalidate()
    stopApplication()
    stopPackages()
    stopRuntime()
    stopFocus()
    stopTheme()
    stopSystem()
    window.removeEventListener('storage', storageChanged)
  })
  return {
    appearance,
    skins: {
      sync: group.sync,
      refresh,
      invalidate() {
        invalidate()
        group.invalidate()
      },
    },
  }
}
