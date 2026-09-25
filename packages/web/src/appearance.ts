import { renderRegion } from '@agnes/web-ui'
import { createElement, type ReactNode } from 'react'
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

/**
 * 把设置对话框「通用」分页的单选组接到偏好上。
 *
 * 变更即时生效；写存储失败只损失持久化，不回滚已应用的外观。
 * 两个组各自独立，互不影响。
 */
export function bindAppearance(options: {
  scope: ParentNode
  root: ThemeRoot & FontScaleRoot
  storage: Pick<Storage, 'getItem' | 'setItem'>
  prefersDark?: () => boolean
}): AppearanceController {
  const prefersDark = options.prefersDark ?? (() => systemPrefersDark(globalThis))
  const themeInputs = [...options.scope.querySelectorAll<HTMLInputElement>(THEME_INPUT)]
  const fontScaleInputs = [...options.scope.querySelectorAll<HTMLInputElement>(FONT_SCALE_INPUT)]

  const sync = (): void => {
    const theme = readThemePreference(options.storage)
    for (const input of themeInputs) input.checked = input.value === theme
    const scale = readFontScale(options.storage)
    for (const input of fontScaleInputs) input.checked = input.value === scale
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

type SkinOptionsProps = {
  skins: readonly SkinOption[]
  selected: string
  status: string | null
  failed: boolean
  onChoose(value: string): void
  onRetry(): void
}

function skinOption(value: string, name: string, hint: string, props: SkinOptionsProps): ReactNode {
  return createElement(
    'label',
    { className: 'appearance-option' },
    createElement('input', {
      type: 'radio',
      name: 'agnes-skin',
      value,
      checked: value === props.selected,
      readOnly: true,
    }),
    createElement(
      'span',
      { className: 'appearance-option-copy' },
      createElement('span', { className: 'appearance-option-name' }, name),
      hint === '' ? null : createElement('span', { className: 'appearance-option-hint' }, hint),
    ),
  )
}

function skinOptions(props: SkinOptionsProps): ReactNode {
  if (props.failed)
    return createElement(
      'p',
      { className: 'appearance-option-hint' },
      '皮肤清单读取失败。',
      createElement('button', { type: 'button', onClick: props.onRetry }, '重试'),
    )
  return createElement(
    'div',
    null,
    skinOption(NO_SKIN, '跟随主题（默认）', '只使用内置配色，不加载任何皮肤', props),
    ...props.skins.map((skin) => skinOption(skin.id, skin.name, `来自 ${skin.packageName}`, props)),
    createElement('p', { className: 'appearance-option-hint', hidden: props.status === null }, props.status),
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
  let selected = readSkinCache(options.storage)?.id ?? NO_SKIN
  let skins: readonly SkinOption[] = []
  let status: string | null = null
  let failed = false

  const render = (): void => {
    renderRegion(
      container,
      createElement(skinOptions, {
        skins,
        selected,
        status,
        failed,
        onChoose: choose,
        onRetry: () => void refresh(),
      }),
    )
  }

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
        status = '这份皮肤没有生效，已保留原选择。'
        render()
      })
  }

  container.addEventListener(
    'change',
    (event) => {
      const input = event.target as HTMLInputElement | null
      if (input?.type === 'radio' && input.name === 'agnes-skin' && input.checked) choose(input.value)
    },
    true,
  )

  // 初始加载由调用方在打开面板时触发（`refresh`），避免绑定即发请求、也避免一次打开拉两遍。
  return { sync, refresh }
}
