import {
  Button,
  createSelectPicker,
  renderRegion,
  Segmented,
  SettingsState,
  setSettingsSelectOptions,
} from '@agnes/web-ui'
import { createElement, type ReactNode } from 'react'
import { tr } from './locale-bridge.js'
import {
  applyLocaleText,
  isUiLocale,
  syncLocaleRadios,
  UI_LOCALE_NAMES,
  UI_LOCALES,
  type UiLocale,
} from './locale-preference.js'
import { readSkinCache } from './skin.js'
import {
  applyFontScale,
  applyTheme,
  type FontScaleRoot,
  isFontScale,
  isThemePreference,
  readFontScale,
  readThemePreference,
  resolveTheme,
  systemPrefersDark,
  type ThemeRoot,
  writeFontScale,
  writeThemePreference,
} from './theme.js'

export type AppearanceController = {
  /** Fill radio groups with current preferences. Reread when opening the panel because another same-origin document may have changed them. */
  sync(): void
}

const THEME_INPUT = 'input[name="agnes-theme"]'
const FONT_SCALE_INPUT = 'input[name="agnes-font-scale"]'
const LOCALE_INPUT = 'input[name="agnes-locale"]'

export type AppearanceLocale = {
  rendered?: boolean
  current(): UiLocale
  /** Persist the preference and switch locale. This module fills translated text after the call. */
  select(locale: UiLocale): void
  text(key: string): string
}

/**
 * Bind radio groups on the settings dialog General page to preferences.
 *
 * Changes apply immediately; failed writes only lose persistence without rolling back the appearance.
 * Theme, font size and locale are independent.
 */
export function bindAppearance(options: {
  scope: ParentNode
  root: ThemeRoot & FontScaleRoot
  storage: Pick<Storage, 'getItem' | 'setItem'>
  prefersDark?: () => boolean
  locale?: AppearanceLocale
}): AppearanceController {
  const prefersDark = options.prefersDark ?? (() => systemPrefersDark(globalThis))
  const themeInputs = [...options.scope.querySelectorAll<HTMLInputElement>(THEME_INPUT)]
  const fontScaleHost = options.scope.querySelector<HTMLElement>('#font-scale-choices')
  const fontScaleInputs = [...options.scope.querySelectorAll<HTMLInputElement>(FONT_SCALE_INPUT)]
  const localeInputs = [...options.scope.querySelectorAll<HTMLInputElement>(LOCALE_INPUT)]
  // The language picker lists whatever interface languages exist, each in its own name.
  const localeSelect = options.scope.querySelector<HTMLSelectElement>('#locale-select')
  if (localeSelect)
    setSettingsSelectOptions(
      localeSelect,
      UI_LOCALES.map((value) => ({ value, label: UI_LOCALE_NAMES[value] })),
    )
  // The picker's accessible label is fixed when it is made, so it is remade when the language changes.
  let localePickerLabel = tr('settings.appearance.language')
  let localePicker = localeSelect ? createSelectPicker(localeSelect, { label: localePickerLabel }) : undefined

  const sync = (): void => {
    const theme = readThemePreference(options.storage)
    for (const input of themeInputs) input.checked = input.value === theme
    const scale = readFontScale(options.storage)
    for (const input of fontScaleInputs) input.checked = input.value === scale
    if (fontScaleHost)
      renderRegion(
        fontScaleHost,
        createElement(Segmented, {
          label: tr('settings-shell.fontScale'),
          name: 'agnes-font-scale',
          value: scale,
          options: [
            { value: 'small', label: tr('settings-shell.fontSmall') },
            { value: 'normal', label: tr('settings-shell.fontNormal') },
            { value: 'large', label: tr('settings-shell.fontLarge') },
          ],
          onChange(value: string) {
            if (!isFontScale(value)) return
            writeFontScale(options.storage, value)
            applyFontScale(options.root, value)
            sync()
          },
        }),
      )
    if (options.locale) {
      syncLocaleRadios(options.scope, options.locale.current())
      if (!options.locale.rendered) applyLocaleText(options.scope, options.locale.text)
    }
    const label = tr('settings.appearance.language')
    if (localeSelect && localePicker && label !== localePickerLabel) {
      localePicker.destroy()
      localePickerLabel = label
      localePicker = createSelectPicker(localeSelect, { label })
    }
    localePicker?.sync()
  }

  for (const input of themeInputs) {
    input.addEventListener('change', () => {
      // Only the newly selected radio emits change; ignore unselected entries to avoid overwriting the new value.
      if (!input.checked || !isThemePreference(input.value)) return
      writeThemePreference(options.storage, input.value)
      applyTheme(options.root, resolveTheme(input.value, prefersDark()))
      // The client-modules ThemeService subscribes to this event without changing this module's internal state shape.
      window.dispatchEvent(new CustomEvent('agnes:theme-changed'))
    })
  }

  for (const input of fontScaleInputs) {
    input.addEventListener('change', () => {
      if (!input.checked || !isFontScale(input.value)) return
      writeFontScale(options.storage, input.value)
      applyFontScale(options.root, input.value)
    })
  }

  for (const input of localeInputs) {
    input.addEventListener('change', () => {
      if (!input.checked || !isUiLocale(input.value) || !options.locale) return
      options.locale.select(input.value)
      sync()
    })
  }

  localeSelect?.addEventListener('change', () => {
    if (!isUiLocale(localeSelect.value) || !options.locale) return
    options.locale.select(localeSelect.value)
    sync()
  })

  sync()
  return { sync }
}

/** Skin manifest entry: display and addressing information only; callers fetch stylesheet contents as needed. */
export type SkinOption = { id: string; name: string; packageName: string }

export type SkinGroupOptions = {
  /** Skin group container, the scope containing `#skin-option-items`. */
  scope: ParentNode
  /** Read the current selection; the selection flow writes the cache, while this only reads it. */
  storage: Pick<Storage, 'getItem'>
  /**
   * List installed skins declared by **enabled and trusted** packages only. Throw on failure so
   * this module can display the error and retry instead of disguising it as no skins.
   */
  list: () => Promise<readonly SkinOption[]>
  /**
   * Select a skin (`null` = built-in appearance). The implementation fetches CSS, caches and applies it.
   * Throwing means selection did not take effect; the UI reports the error and retains the previous choice.
   */
  select: (id: string | null) => Promise<void> | void
}

export type SkinGroupController = { sync: () => void; refresh: () => Promise<void> }

/** The built-in appearance value: an empty string, distinct from every valid skin id. */
const NO_SKIN = ''

type SkinStatusProps = { status: string | null; failed: boolean; onRetry(): void }

/** What sits under the skin picker: nothing, a note that the choice did not apply, or a retry. */
function skinStatus(props: SkinStatusProps): ReactNode {
  if (props.failed)
    return createElement(
      SettingsState,
      { tone: 'error', className: 'appearance-option-hint' },
      tr('settings.appearance.skinListFailed'),
      createElement(Button, { htmlType: 'button', onClick: props.onRetry }, tr('settings.appearance.retry')),
    )
  return createElement(
    'p',
    { className: 'appearance-option-hint', hidden: props.status === null },
    props.status,
  )
}

/**
 * Bind the skin radio group in General → Appearance to the installed skin manifest.
 *
 * Selection **applies immediately** by calling `select`, which fetches CSS, caches and applies it.
 * This module owns no stylesheet text, so it needs neither reloads nor requests here. Manifest fetch
 * failures are **visible with retry**; selection failures retain the previous choice and report the error.
 */
export function bindSkinGroup(options: SkinGroupOptions): SkinGroupController {
  const container = options.scope.querySelector<HTMLElement>('#skin-option-items')
  if (container === null) throw new Error('skin options container is missing')
  const select = options.scope.querySelector<HTMLSelectElement>('#skin-select')
  if (select === null) throw new Error('skin select is missing')
  let pickerLabel = tr('settings-shell.skin')
  let picker = createSelectPicker(select, { label: pickerLabel })
  let selected = readSkinCache(options.storage)?.id ?? NO_SKIN
  let skins: readonly SkinOption[] = []
  let status: string | null = null
  let failed = false

  // The list is whatever is installed right now: the built-in look first, then every skin with the
  // package it came from. A cached skin that is no longer installed falls back to the built-in look.
  const render = (): void => {
    // A late roster or selection reply cannot update a pane the host has already unmounted.
    if (!select.isConnected || !container.isConnected) return
    setSettingsSelectOptions(select, [
      { value: NO_SKIN, label: tr('settings.appearance.followTheme') },
      ...skins.map((skin) => ({
        value: skin.id,
        label: `${skin.name} · ${tr('settings.appearance.fromPackage', { package: skin.packageName })}`,
      })),
    ])
    select.value = skins.some((skin) => skin.id === selected) ? selected : NO_SKIN
    select.disabled = failed
    const label = tr('settings-shell.skin')
    if (label !== pickerLabel) {
      picker.destroy()
      pickerLabel = label
      picker = createSelectPicker(select, { label })
    }
    picker.sync()
    renderRegion(container, createElement(skinStatus, { status, failed, onRetry: () => void refresh() }))
  }
  select.addEventListener('change', () => choose(select.value))

  const sync = (): void => render()

  const refresh = async (): Promise<void> => {
    try {
      skins = await options.list()
      selected = readSkinCache(options.storage)?.id ?? NO_SKIN
      status = null
      failed = false
      render()
    } catch {
      status = null
      failed = true
      render()
    }
  }

  const choose = (value: string): void => {
    const previous = selected
    selected = value
    render()
    void Promise.resolve(options.select(selected === NO_SKIN ? null : selected))
      .then(() => {
        status = null
        render()
      })
      .catch(() => {
        // Selection did not take effect: restore the previous choice instead of leaving a false selected state.
        selected = previous
        status = tr('settings.appearance.skinNotApplied')
        render()
      })
  }

  // The caller triggers initial loading with `refresh` when opening the panel, avoiding requests on bind or duplicate loads.
  return { sync, refresh }
}
