/**
 * 主题偏好的纯逻辑：读写、解析、应用。
 *
 * 与 DOM 的接触面刻意收窄成 `classList` 一个方法，使本模块可在无 DOM 环境下单测。
 * `color-scheme` 不在这里改——它由样式表的 `:root` / `.dark` 负责，避免与首帧竞态。
 */

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

/**
 * 应用主题只需要「能切换一个类名」这一件事，刻意不依赖完整的 `DOMTokenList`——
 * 接触面越窄，越能在无 DOM 环境里测。
 */
export type ThemeRoot = { classList: { toggle(token: string, force?: boolean): void } }

export const THEME_STORAGE_KEY = 'agnes-theme'

const PREFERENCES: readonly string[] = ['system', 'light', 'dark']

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && PREFERENCES.includes(value)
}

/**
 * 非法值、缺失值与读取异常一律回落 `system`。
 * 隐私模式下访问 `localStorage` 本身可能抛异常，所以取值必须在 try 内。
 */
export function readThemePreference(storage: Pick<Storage, 'getItem'>): ThemePreference {
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

/**
 * 写失败不冒泡：本次切换仍应即时生效，只损失持久化。
 */
export function writeThemePreference(storage: Pick<Storage, 'setItem'>, value: ThemePreference): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, value)
  } catch {
    // 配额用尽或存储被禁用时静默降级。
  }
}

/**
 * 取一个读写都不抛的存储视图。
 *
 * 隐私模式下**读取 `localStorage` 这个属性本身**就可能抛异常，所以属性访问也要在 try 内；
 * 拿不到时退化成空实现，让偏好一律回落到 `system`。
 */
export function safeThemeStorage(
  source: { localStorage?: unknown } = globalThis,
): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  try {
    const value = source.localStorage
    const candidate = value as Partial<Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>> | null | undefined
    const get = candidate?.getItem
    const set = candidate?.setItem
    const remove = candidate?.removeItem
    // `removeItem` stays optional: widening this helper for the skin cache must not make an existing
    // storage that only reads and writes stop being usable.
    if (typeof get === 'function' && typeof set === 'function')
      return {
        getItem: (key) => get.call(candidate, key),
        setItem: (key, value) => set.call(candidate, key, value),
        removeItem: typeof remove === 'function' ? (key) => remove.call(candidate, key) : () => undefined,
      }
  } catch {
    // 落到下面的空实现。
  }
  return { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference
}

// ── 字号 ───────────────────────────────────────────────────────────────
// 全站尺度都用 rem，所以只改根元素字号就能整体缩放，不需要碰任何组件规则。

export type FontScale = 'small' | 'normal' | 'large'

export const FONT_SCALE_STORAGE_KEY = 'agnes-font-scale'

const FONT_SCALES: readonly string[] = ['small', 'normal', 'large']
const FONT_SCALE_PERCENT: Record<FontScale, string> = {
  small: '87.5%',
  normal: '100%',
  large: '112.5%',
}

export function isFontScale(value: unknown): value is FontScale {
  return typeof value === 'string' && FONT_SCALES.includes(value)
}

export function readFontScale(storage: Pick<Storage, 'getItem'>): FontScale {
  try {
    const raw = storage.getItem(FONT_SCALE_STORAGE_KEY)
    return isFontScale(raw) ? raw : 'normal'
  } catch {
    return 'normal'
  }
}

export function writeFontScale(storage: Pick<Storage, 'setItem'>, value: FontScale): void {
  try {
    storage.setItem(FONT_SCALE_STORAGE_KEY, value)
  } catch {
    // 同 writeThemePreference：写失败只损失持久化。
  }
}

/** 只接受能承接 fontSize 的最小结构，便于在无 DOM 环境单测。 */
export type FontScaleRoot = { style: { fontSize: string } }

export function applyFontScale(root: FontScaleRoot, scale: FontScale): void {
  root.style.fontSize = FONT_SCALE_PERCENT[scale]
}

export function applyTheme(root: ThemeRoot, theme: ResolvedTheme): void {
  root.classList.toggle('dark', theme === 'dark')
}

/** 判断系统当前是否偏好深色；`matchMedia` 不可用时按浅色处理。 */
export function systemPrefersDark(target: { matchMedia?: unknown } = globalThis): boolean {
  if (typeof target.matchMedia !== 'function') return false
  const query = (target.matchMedia as (value: string) => MediaQueryList)('(prefers-color-scheme: dark)')
  return query.matches
}

/**
 * 订阅系统深浅色变化，返回解绑函数。
 *
 * **无条件订阅**，是否真的跟随由回调自行判断（回调里重读偏好即可）。
 * 不按「启动时的偏好」决定是否订阅：否则用户中途从「浅色」切到「跟随系统」时
 * 订阅不存在，要一直等下次刷新才生效。`matchMedia` 不可用时返回空操作。
 */
export function watchSystemTheme(target: { matchMedia?: unknown }, onChange: () => void): () => void {
  if (typeof target.matchMedia !== 'function') return () => undefined
  const query = (target.matchMedia as (value: string) => MediaQueryList)('(prefers-color-scheme: dark)')
  const listener = (): void => onChange()
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}
