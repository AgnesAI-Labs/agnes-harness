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

export type SkinGroupView = {
  selected: string
  skins: readonly { value: string; name: string; packageName: string; version: string }[]
  unavailable: boolean
}

export type SkinGroupOptions = {
  scope: ParentNode
  list(): Promise<SkinGroupView>
  select(value: string): Promise<void>
}

export type SkinGroupController = { sync(): void; refresh(): Promise<void>; invalidate(): void }

const NO_SKIN = ''
const APPLICATION_SKIN = 'application'
const UNAVAILABLE_SKIN = 'unavailable'

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
    { className: 'appearance-option-hint', hidden: props.status === null, role: 'status' },
    props.status,
  )
}

/** Render the daemon's current choice and submit explicit choices back through the host. */
export function bindSkinGroup(options: SkinGroupOptions): SkinGroupController {
  const container = options.scope.querySelector<HTMLElement>('#skin-option-items')
  if (container === null) throw new Error('skin options container is missing')
  const select = options.scope.querySelector<HTMLSelectElement>('#skin-select')
  if (select === null) throw new Error('skin select is missing')
  let pickerLabel = tr('settings-shell.skin')
  let picker = createSelectPicker(select, { label: pickerLabel })
  let view: SkinGroupView | undefined
  let failed = false
  let selecting = false
  let refreshing = false
  let request = 0
  let status: 'select-failed' | undefined

  const render = (): void => {
    // A late roster or selection reply cannot update a pane the host has already unmounted.
    if (!select.isConnected || !container.isConnected) return
    setSettingsSelectOptions(select, [
      { value: APPLICATION_SKIN, label: tr('settings.appearance.applicationSkin') },
      { value: NO_SKIN, label: tr('settings.appearance.followTheme') },
      ...(view?.unavailable ? [{ value: UNAVAILABLE_SKIN, label: tr('settings.appearance.savedSkin') }] : []),
      ...(view?.skins ?? []).map((skin) => ({
        value: skin.value,
        label: `${skin.name} · ${tr('settings.appearance.fromPackage', { package: `${skin.packageName} ${skin.version}` })}`,
      })),
    ])
    select.value = view?.unavailable ? UNAVAILABLE_SKIN : (view?.selected ?? APPLICATION_SKIN)
    select.disabled = !view || failed || selecting || refreshing
    const label = tr('settings-shell.skin')
    if (label !== pickerLabel) {
      picker.destroy()
      pickerLabel = label
      picker = createSelectPicker(select, { label })
    }
    picker.sync()
    const message =
      status === 'select-failed'
        ? tr('settings.appearance.skinNotApplied')
        : view?.unavailable
          ? tr('settings.appearance.skinUnavailable')
          : null
    renderRegion(
      container,
      createElement(skinStatus, { status: message, failed, onRetry: () => void refresh() }),
    )
  }

  const sync = (): void => render()

  const refresh = async (): Promise<void> => {
    if (selecting) return
    const epoch = ++request
    refreshing = true
    if (view) render()
    try {
      const next = await options.list()
      if (epoch !== request) return
      view = next
      failed = false
    } catch {
      if (epoch !== request) return
      view = undefined
      failed = true
    }
    refreshing = false
    render()
  }

  const choose = async (value: string): Promise<void> => {
    if (!view || selecting || refreshing || failed || !select.isConnected) return
    if (value !== NO_SKIN && value !== APPLICATION_SKIN && !view.skins.some((skin) => skin.value === value))
      return
    request += 1
    selecting = true
    status = undefined
    render()
    try {
      await options.select(value)
    } catch {
      status = 'select-failed'
    } finally {
      selecting = false
      await refresh()
    }
  }
  select.addEventListener('change', () => void choose(select.value))

  render()
  return {
    sync,
    refresh,
    invalidate() {
      request += 1
      refreshing = false
      failed = false
      view = undefined
      render()
    },
  }
}
