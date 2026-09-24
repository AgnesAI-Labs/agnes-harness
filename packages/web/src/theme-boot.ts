import {
  applySkinTokens,
  readSkinCache,
  SKIN_STORAGE_KEY,
  type SkinSheetState,
  selectedSkin,
  skinOverride,
  syncSkinSheet,
} from './skin.js'
import {
  applyFontScale,
  applyTheme,
  type ResolvedTheme,
  readFontScale,
  readThemePreference,
  resolveTheme,
  safeThemeStorage,
  systemPrefersDark,
  THEME_STORAGE_KEY,
  watchSystemTheme,
} from './theme.js'

/**
 * 首帧防闪烁入口。
 *
 * 本文件必须打成 **IIFE** 并以阻塞式 `<script src="/theme.js">` 放在三个页面的 `<head>` 里：
 * 模块脚本一律 defer，会先渲染一帧浅色再翻深色，正好是我们要避免的闪烁。
 * CSP 是 `script-src 'self'` 且没有 `unsafe-inline`，所以业界常用的「head 内联脚本」
 * 在这里会被拦——独立 IIFE 文件是唯一可行解。
 *
 * 全部动作包在容错里：存储不可用、`matchMedia` 缺失都只降级，不允许阻断页面加载。
 */

const storage = safeThemeStorage(window)
/** 一次性覆盖（`?skin=none|<id>`）只在本次加载生效，不写缓存。 */
const override = skinOverride(window.location.search)
let writtenSkinTokens: Set<string> = new Set()
let skinSheet: SkinSheetState = { sheet: undefined, css: undefined }

/**
 * 皮肤样式表走**构造式样式表 + `adoptedStyleSheets`**。
 *
 * 不能用 `<style>`：`style-src 'self'` 且无 `unsafe-inline` 会把它拦掉（CSP spike 的负向对照已实测）。
 * 构造式样式表不受 `style-src` 管辖，且层叠顺序在文档样式表**之后**，因此天然压过 `style.css`，
 * 也顺带绕开了「本文件早于 `style.css` 解析」的顺序问题。
 * 引擎不支持这一能力时只放弃样式表部分；token 与深浅色照常，不让可选能力阻断加载。
 */
const paintSkin = (mode: ResolvedTheme): void => {
  const skin = selectedSkin(readSkinCache(storage), override)
  writtenSkinTokens = applySkinTokens(document.documentElement, skin, mode, writtenSkinTokens)
  if (typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in document)) return
  try {
    // `syncSkinSheet` 也会在「关掉皮肤」或「这份皮肤没有样式表文本」时**摘除**自己的那张表：
    // 留着它就会让上一份皮肤继续上色，而 token 已经跟着新的选择走了。
    skinSheet = syncSkinSheet(document, skinSheet, skin?.css ?? '', () => new CSSStyleSheet())
  } catch {
    // 非法 CSS 或引擎拒绝：保持上一次生效状态，不清空、不阻断页面。
  }
}

/** 每次都重读偏好：这样系统主题变化时能按「当时的」偏好决定是否跟随。 */
const paint = (): void => {
  const mode = resolveTheme(readThemePreference(storage), systemPrefersDark(window))
  applyTheme(document.documentElement, mode)
  // 字号同样在首帧前定好，避免先按 100% 排一次版再跳。
  applyFontScale(document.documentElement, readFontScale(storage))
  paintSkin(mode)
}

paint()

// 无条件订阅：用户中途从「浅色」切到「跟随系统」时无需重新订阅即可生效。
watchSystemTheme(window, paint)

// 同源的其他文档改了偏好或换了皮肤时同步（设置对话框里嵌的 admin / resources iframe）。
// storage 事件只在「其他」文档触发，所以这里不会与自身写入形成回环。
window.addEventListener('storage', (event) => {
  if (event.key !== THEME_STORAGE_KEY && event.key !== SKIN_STORAGE_KEY) return
  paint()
})

// Same-document preference changes do not emit a storage event. Repaint skin tokens too.
window.addEventListener('agnes:theme-changed', paint)
