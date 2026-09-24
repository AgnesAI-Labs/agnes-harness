/**
 * 皮肤偏好的纯逻辑：缓存读写、一次性覆盖参数、以及按当前深浅模式把 token 落到根元素。
 *
 * 与 DOM 的接触面刻意收窄成「能写、能删一个自定义属性」这一件事，使本模块可在无 DOM 环境下单测。
 * 构造式样式表与 `adoptedStyleSheets` 的应用留在 `theme-boot`（那里本来就要碰 `document`），
 * 不在这里假装拥有文档。
 */

import type { ResolvedTheme } from './theme.js'

export type SkinTokenModes = { light: string; dark: string }
/** 缓存下来的当前皮肤：样式表文本 + token 值 + 生成它的清单 revision。 */
export type SkinCache = {
  version: typeof SKIN_CACHE_VERSION
  id: string
  revision: string
  css: string
  tokens: Record<string, SkinTokenModes>
}

/**
 * 清单里的一项，按客户端需要的最小形态归一：身份 + 怎么取样式表 + 归一后的 token。
 * `css` 缺席表示宿主没内联（超过内联上限或读不到），此时必须走 `cssUrl` 回落（设计 §5.8/§21.5）。
 */
export type SkinRosterEntry = {
  id: string
  name: string
  packageName: string
  /** 该条目来自哪份清单摘要；变了就需要与缓存对账。 */
  revision: string
  /** 样式表路由，同源，形如 `/skins/<id>/skin.css`。 */
  cssUrl: string
  /** 内联的样式表文本；缺席时不代表「没有样式表」，只代表要自己去取。 */
  css?: string
  tokens: Record<string, SkinTokenModes>
}

export const SKIN_STORAGE_KEY = 'agnes-skin'
/** 不匹配即丢弃缓存并按「没有皮肤」处理，不用旧格式猜。 */
export const SKIN_CACHE_VERSION = 1
/** `?skin=none` 的取值：强制回到内置外观。 */
export const SKIN_NONE = 'none'
/** 与协议层 `SkinId` 同一形态。 */
const SKIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 校验 token 表：每个键都必须同时给出非空的 light 与 dark。 */
function readTokens(value: unknown): Record<string, SkinTokenModes> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const tokens: Record<string, SkinTokenModes> = {}
  for (const [name, modes] of Object.entries(value as Record<string, unknown>)) {
    if (typeof modes !== 'object' || modes === null || Array.isArray(modes)) return null
    const { light, dark } = modes as Record<string, unknown>
    if (typeof light !== 'string' || light === '' || typeof dark !== 'string' || dark === '') return null
    tokens[name] = { light, dark }
  }
  return tokens
}

/**
 * 读取缓存的皮肤。损坏的 JSON、版本不匹配、缺字段与非法 id 一律回落 `null`，
 * 因为缓存是「可丢弃的加速器」，不是权威。
 */
export function readSkinCache(storage: Pick<Storage, 'getItem'>): SkinCache | null {
  try {
    const raw = storage.getItem(SKIN_STORAGE_KEY)
    if (raw === null) return null
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (record.version !== SKIN_CACHE_VERSION) return null
    if (typeof record.id !== 'string' || !SKIN_ID.test(record.id)) return null
    if (typeof record.revision !== 'string' || typeof record.css !== 'string') return null
    const tokens = readTokens(record.tokens)
    if (tokens === null) return null
    return { version: SKIN_CACHE_VERSION, id: record.id, revision: record.revision, css: record.css, tokens }
  } catch {
    // 隐私模式下读取本身可能抛；损坏内容同理，都按「没有皮肤」处理。
    return null
  }
}

/** 写失败只损失持久化，本次切换仍应即时生效。 */
export function writeSkinCache(storage: Pick<Storage, 'setItem'>, cache: SkinCache): void {
  try {
    storage.setItem(SKIN_STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // 配额用尽或存储被禁用时静默降级。
  }
}

/** 清除缓存（皮肤被卸载、清单 revision 失配、或用户选了「不用皮肤」）。 */
export function clearSkinCache(storage: Pick<Storage, 'removeItem'>): void {
  try {
    storage.removeItem(SKIN_STORAGE_KEY)
  } catch {
    // 同 writeSkinCache：只损失持久化。
  }
}

/**
 * 解析 `?skin=` 一次性覆盖。只认 `none` 与合法 id；**非法或缺失一律返回 `null`（不作为覆盖）**，
 * 这样写错参数只会回落到用户原本的选择，而不是意外关掉皮肤。
 * @param search - `location.search`（含或不含前导 `?`）。
 */
export function skinOverride(search: string): string | null {
  let value: string | null
  try {
    value = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('skin')
  } catch {
    return null
  }
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === SKIN_NONE) return SKIN_NONE
  return SKIN_ID.test(trimmed) ? trimmed : null
}

/**
 * 一次性覆盖优先于缓存。
 * `?skin=<id>` 只能在缓存里**正好是那份皮肤**时生效——首帧没有网络可用，
 * 所以强制指定一份尚未缓存的皮肤不会凭空出现，它退回内置外观，待运行时再取。
 * @returns 首帧应当应用的皮肤，`null` 表示内置外观。
 */
export function selectedSkin(cache: SkinCache | null, override: string | null): SkinCache | null {
  if (override === null) return cache
  if (override === SKIN_NONE) return null
  return cache !== null && cache.id === override ? cache : null
}

/** 只承接写/删自定义属性的最小结构，便于在无 DOM 环境单测。 */
export type SkinTokenRoot = {
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void }
}

/**
 * 把皮肤在当前模式下的 token 写到根元素。
 *
 * **精确清除**：只删「上次写过、这次不需要」的那些属性，绝不按通配删除——
 * 否则会连带清掉别的写入方（例如组件自己的局部自定义属性）。
 * @param root - 根元素（或任何能承接自定义属性的等价结构）。
 * @param cache - 要应用的皮肤，`null` 表示只做清除。
 * @param mode - 当前解析出的深浅模式。
 * @param applied - 上一次调用返回的属性名集合。
 * @returns 本次实际写入的属性名集合，供下次调用作为 `applied` 传入。
 */
export function applySkinTokens(
  root: SkinTokenRoot,
  cache: SkinCache | null,
  mode: ResolvedTheme,
  applied: Iterable<string>,
): Set<string> {
  const wanted = new Map<string, string>()
  if (cache !== null)
    for (const [name, modes] of Object.entries(cache.tokens)) {
      const value = mode === 'dark' ? modes.dark : modes.light
      if (value !== '') wanted.set(name, value)
    }
  for (const name of applied) if (!wanted.has(name)) root.style.removeProperty(name)
  for (const [name, value] of wanted) root.style.setProperty(name, value)
  return new Set(wanted.keys())
}

/** 本项目会碰的 adopted stylesheet 表面；`document` 天然满足。 */
export type SkinSheetHost = { adoptedStyleSheets: CSSStyleSheet[] }

/**
 * 本模块**独占**的那张样式表，以及它当前承载的 CSS 文本。
 * `undefined` = 还没应用过；`''` = 当前不应有任何皮肤样式。
 */
export type SkinSheetState = Readonly<{ sheet: CSSStyleSheet | undefined; css: string | undefined }>

/**
 * 让宿主的 adopted stylesheet 与 `css` 一致，且只拥有其中一张。
 *
 * **移除与安装同等重要**：用户关掉皮肤、或切到一份宿主没内联样式表的皮肤时，遗留的 sheet 会
 * 让上一份皮肤继续上色，而 token 已经跟着新选择走了——「关不掉的皮肤」正是这样来的（设计 §5.8/§8）。
 * 除本模块自己的那张外，绝不动任何其他 sheet。
 *
 * 新表先填好**再**接入，所以引擎拒绝这份 CSS 时留下的仍是上一张生效中的表，而不是换来一张空表。
 * @returns 下次调用应传入的状态；抛错时调用方保留上一次状态。
 */
export function syncSkinSheet(
  host: SkinSheetHost,
  state: SkinSheetState,
  css: string,
  createSheet: () => CSSStyleSheet,
): SkinSheetState {
  if (css === state.css) return state
  if (css === '') {
    if (state.sheet !== undefined)
      host.adoptedStyleSheets = host.adoptedStyleSheets.filter((sheet) => sheet !== state.sheet)
    return { sheet: undefined, css: '' }
  }
  const sheet = createSheet()
  sheet.replaceSync(css)
  const kept =
    state.sheet === undefined
      ? [...host.adoptedStyleSheets]
      : host.adoptedStyleSheets.filter((existing) => existing !== state.sheet)
  host.adoptedStyleSheets = [...kept, sheet]
  return { sheet, css }
}

export type SkinReconcilePlan =
  | Readonly<{ kind: 'keep' }>
  /** 缓存皮肤的来源已被卸载/停用：丢弃它并回落内置观感（设计 §8）。 */
  | Readonly<{ kind: 'clear' }>
  /** 清单在缓存皮肤脚下动了：按这一项重新解析样式表。 */
  | Readonly<{ kind: 'refresh'; entry: SkinRosterEntry }>

/**
 * 拿到新清单后决定缓存要怎么处理。
 *
 * 没有缓存时也是 `keep`：用户本来就没选皮肤，没有可对账的东西。**只有在真的拿到清单后才调用**，
 * 否则「取不到清单」会被误读成「皮肤全被卸载」而抹掉用户的选择。
 */
export function planSkinReconcile(
  cached: SkinCache | null,
  entries: readonly SkinRosterEntry[],
): SkinReconcilePlan {
  if (cached === null) return { kind: 'keep' }
  const entry = entries.find((candidate) => candidate.id === cached.id)
  if (entry === undefined) return { kind: 'clear' }
  return cached.revision === entry.revision ? { kind: 'keep' } : { kind: 'refresh', entry }
}

/** 本模块需要的 `fetch` 切片，好让回落路径不依赖网络也能测。 */
export type SkinCssFetcher = (input: string) => Promise<{ ok: boolean; text(): Promise<string> }>

/**
 * 通过清单给的 `cssUrl` 取一份样式表（宿主没内联时的回落路径）。
 *
 * 清单是包派生数据，属不可信输入：URL 一律以页面 origin 重新锚定，且必须留在 `/skins/` 下，
 * 因此一条恶意或畸形的条目无法把它变成对别的 origin、或对无关同源路径的请求。
 * @throws 引用越界、响应非 2xx、或正文为空时抛出——调用方据此保留内置观感，不写半截缓存。
 */
export async function fetchSkinCss(
  cssUrl: string,
  options: { fetcher: SkinCssFetcher; origin: string },
): Promise<string> {
  const url = new URL(cssUrl, options.origin)
  if (url.origin !== options.origin || !url.pathname.startsWith('/skins/'))
    throw new Error('skin stylesheet reference is out of scope')
  const response = await options.fetcher(url.pathname)
  if (!response.ok) throw new Error('skin stylesheet is unavailable')
  const css = await response.text()
  if (css === '') throw new Error('skin stylesheet is empty')
  return css
}

/**
 * 取到一份皮肤需要的全部文本并写入缓存——选中与清单对账共用这一步。
 *
 * 宿主内联了就直接用，没有才走 `cssUrl`；**取不到就抛，绝不写一份 css 为空的缓存**——
 * 那正是「点了等于没点」的成因：界面显示已选中，页面却没有任何皮肤样式（设计 §8）。
 * @returns 写进缓存的形态，供调用方直接复用。
 */
export async function cacheSkinEntry(
  storage: Pick<Storage, 'setItem'>,
  entry: SkinRosterEntry,
  options: { fetcher: SkinCssFetcher; origin: string },
): Promise<SkinCache> {
  const css = entry.css ?? (await fetchSkinCss(entry.cssUrl, options))
  const cached: SkinCache = {
    version: SKIN_CACHE_VERSION,
    id: entry.id,
    revision: entry.revision,
    css,
    tokens: entry.tokens,
  }
  writeSkinCache(storage, cached)
  return cached
}
