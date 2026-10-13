import {
  Button,
  createSelectPicker,
  renderRegion,
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
  /** 把各单选组回填成当前偏好。设置可能被其他同源文档改过，打开面板时重新拉一次。 */
  sync(): void
}

const THEME_INPUT = 'input[name="agnes-theme"]'
const FONT_SCALE_INPUT = 'input[name="agnes-font-scale"]'
const LOCALE_INPUT = 'input[name="agnes-locale"]'

export type AppearanceLocale = {
  rendered?: boolean
  current(): UiLocale
  /** 写入偏好并切换语言。文案回填由本模块在调用之后完成。 */
  select(locale: UiLocale): void
  text(key: string): string
}

/**
 * 把设置对话框「通用」分页的单选组接到偏好上。
 *
 * 变更即时生效；写存储失败只损失持久化，不回滚已应用的外观。
 * 配色、字号和语言各自独立，互不影响。
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
      // 单选组里只有刚被选中的那个会派发 change；忽略未选中项，避免用旧值覆盖新值。
      if (!input.checked || !isThemePreference(input.value)) return
      writeThemePreference(options.storage, input.value)
      applyTheme(options.root, resolveTheme(input.value, prefersDark()))
      // client-modules 的 ThemeService 订阅此事件（不改本模块的内部状态结构）。
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
      if (!options.locale.rendered) applyLocaleText(options.scope, options.locale.text)
    })
  }

  localeSelect?.addEventListener('change', () => {
    if (!isUiLocale(localeSelect.value) || !options.locale) return
    options.locale.select(localeSelect.value)
    if (!options.locale.rendered) applyLocaleText(options.scope, options.locale.text)
  })

  sync()
  return { sync }
}

/** 皮肤清单里的一项：只带展示与寻址信息，样式表内容由调用方按需取。 */
export type SkinOption = { id: string; name: string; packageName: string }

export type SkinGroupOptions = {
  /** 皮肤分组的容器（即包含 `#skin-option-items` 的作用域）。 */
  scope: ParentNode
  /** 读取当前选择；缓存由选择流程负责写入，这里只读。 */
  storage: Pick<Storage, 'getItem'>
  /**
   * 列出已装皮肤。只包含**已启用且已信任**的包声明过的皮肤；失败时抛错，
   * 由本模块呈现失败态与重试，而不是把失败装扮成「没有皮肤」。
   */
  list: () => Promise<readonly SkinOption[]>
  /**
   * 选中一份皮肤（`null` = 内置外观）。实现负责取样式表、写缓存并落地；
   * 抛错表示这次选择没有生效，UI 会提示并保留原选择。
   */
  select: (id: string | null) => Promise<void> | void
}

export type SkinGroupController = { sync: () => void; refresh: () => Promise<void> }

/** 内置外观那一项的值：空串，与任何合法皮肤 id 都不冲突。 */
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
 * 把设置「通用 → 外观」里的皮肤单选组接到已装皮肤清单上。
 *
 * 选择**即时生效**：变更只调用 `select`，由它取样式表、写缓存并落地——本模块不持有样式表内容，
 * 因此不需要刷新、也不需要在这里发请求。清单拉取失败是**可见的失败态**，附重试；
 * 选择失败则保留原选择并提示，不静默改状态。
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
        // 选择没有生效：回到原选择，而不是把一个假的选中态留在界面上。
        selected = previous
        status = tr('settings.appearance.skinNotApplied')
        render()
      })
  }

  // 初始加载由调用方在打开面板时触发（`refresh`），避免绑定即发请求、也避免一次打开拉两遍。
  return { sync, refresh }
}
