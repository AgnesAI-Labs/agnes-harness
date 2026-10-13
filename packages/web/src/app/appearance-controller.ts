import type { LocaleService } from '@agnes/web-client'
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
  SKIN_STORAGE_KEY,
  type SkinRosterEntry,
} from '@agnes/web-foundation/skin'
import { safeThemeStorage } from '@agnes/web-foundation/theme'
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
 * 皮肤清单来自 `config.get()` 报出的 profile——daemon 只接受它自己那一个 profile，所以这里必须把
 * profile 传回去，客户端不能凭参数选目录。
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
        broadcast('agnes:locale-changed', value)
      },
      text: (key) => options.locale.t(key),
    },
  })
  /** 最近一次拉到的清单，供选中时取样式表与 token；清单变了会整体替换。 */
  let roster: SkinRosterEntry[] = []
  /** 回落到 `cssUrl` 时的同源取数器；只接受 `/skins/` 下的路径（见 `fetchSkinCss`）。 */
  const cssOptions = { fetcher: (input: string) => fetch(input), origin: location.origin }
  /** 每次显式选择 +1：让在途的对账不能把用户刚做的选择覆盖回去。 */
  let selection = 0
  let disposed = false

  /** 告诉首帧逻辑（以及同源的其他文档）缓存里的皮肤变了。同文档不会收到 storage 事件，故手动派发。 */
  const skinChanged = (): void => {
    window.dispatchEvent(new StorageEvent('storage', { key: SKIN_STORAGE_KEY }))
  }

  /**
   * 拿到新清单后把缓存拉回一致。
   *
   * 来源被卸载/停用的皮肤必须**停止上色**（设计 §8）；清单只是摘要变化、文本没变时直接换缓存，
   * 不留闪烁。只有必须联网取文本时才先回落内置观感——那是设计明确接受的那一次闪烁（§5.8）。
   */
  async function reconcile(entries: readonly SkinRosterEntry[]): Promise<void> {
    if (disposed) return
    const plan = planSkinReconcile(readSkinCache(storage), entries)
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
      // 取文本期间用户可能已经换了选择：那就让对账作废，不能把旧皮肤写回去。
      if (disposed || version !== selection) return
      await cacheSkinEntry(storage, { ...plan.entry, css }, cssOptions)
      skinChanged()
    } catch {
      // 取不到就保持内置观感，而不是写一份半截缓存。
    }
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
      // 只有真的拿到清单才能对账：这里的 `[]` 会被读成「皮肤全被卸载」而抹掉用户的选择。
      await reconcile(roster)
      return roster
    },
    select: async (id) => {
      // 先记一次选择：取样式表要 await，在途的对账不能在这个窗口里把旧皮肤写回来。
      selection += 1
      if (id === null) clearSkinCache(storage)
      else {
        const chosen = roster.find((skin) => skin.id === id)
        // 清单里找不到就是清单刚变过：抛出，让分组回滚到原选择而不是留下假的选中态。
        if (chosen === undefined) throw new Error(`skin ${id} is not in the current roster`)
        // 宿主没内联时先取到文本再写缓存，否则会缓存成一份空样式表——点了等于没点（设计 §8）。
        await cacheSkinEntry(storage, chosen, cssOptions)
      }
      skinChanged()
    },
  })
  const stopPackages = onBroadcast('agnes:packages-changed', () => void skins.refresh())
  const stopFocus = onWindowFocus(() => void skins.refresh())
  onPageHide(() => {
    disposed = true
    stopPackages()
    stopFocus()
    selection += 1
  })
  return { appearance, skins }
}
