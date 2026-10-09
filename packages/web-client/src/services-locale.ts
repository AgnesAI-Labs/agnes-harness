import { type Context, Service } from '@agnes/cordis'

export const UI_LOCALES = ['en', 'zh-CN'] as const
export type UiLocale = (typeof UI_LOCALES)[number]

export function resolveUiLocale(value: string | null | undefined): UiLocale {
  return (UI_LOCALES as readonly string[]).includes(value ?? '') ? (value as UiLocale) : 'en'
}

/** 一种语言下的文案。键为消息 key，值为已翻译文本。 */
export type LocaleDictionary = Record<string, string>

/** `ctx.locale.register` 的目录：同一命名空间同时登记 `en` 与 `zh-CN`。 */
export type LocaleCatalog = Partial<Record<UiLocale, LocaleDictionary>>

export type LocaleVars = Readonly<Record<string, string | number>>

function interpolate(template: string, vars: LocaleVars | undefined): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  )
}

export class LocaleService extends Service {
  private currentLocale: UiLocale
  private readonly catalogs = new Map<string, LocaleCatalog>()
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context, initial: string) {
    super(ctx, 'locale')
    this.currentLocale = resolveUiLocale(initial)
  }

  get locale(): UiLocale {
    return this.currentLocale
  }

  /** 注册目录（命名空间 = 包 id）。撤销时自动移除；插件侧经 effect 绑定 fiber。 */
  register(namespace: string, catalog: LocaleCatalog): () => void {
    // Re-registering a namespace is an update, not a second competing seat.
    // Delete first so the newest revision wins deterministic lookup order.
    this.catalogs.delete(namespace)
    this.catalogs.set(namespace, catalog)
    for (const listener of [...this.listeners]) listener()
    return () => {
      if (this.catalogs.get(namespace) !== catalog) return
      this.catalogs.delete(namespace)
      for (const listener of [...this.listeners]) listener()
    }
  }

  /**
   * 查目录：后注册者覆盖先注册者。
   * 当前语言没有该 key 时回落英文，英文也没有则回落 key 本身。
   */
  t(key: string, vars?: LocaleVars): string {
    const direct = this.lookup(this.currentLocale, key)
    const hit = direct ?? (this.currentLocale === 'en' ? undefined : this.lookup('en', key))
    return interpolate(hit ?? key, vars)
  }

  /** Bind a namespace for slot entries that declare `locale`. */
  bind(namespace: string): (key: string, vars?: LocaleVars) => string {
    return (key, vars) => {
      const catalog = this.catalogs.get(namespace)
      const direct = catalog?.[this.currentLocale]?.[key]
      if (direct !== undefined) return interpolate(direct, vars)
      if (this.currentLocale !== 'en') {
        const english = catalog?.en?.[key]
        if (english !== undefined) return interpolate(english, vars)
      }
      return this.t(key, vars)
    }
  }

  /** 仅宿主调用。未知语言回落英文。 */
  setLocale(locale: string): void {
    const next = resolveUiLocale(locale)
    if (next === this.currentLocale) return
    this.currentLocale = next
    for (const listener of [...this.listeners]) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): string => this.currentLocale

  private lookup(locale: UiLocale, key: string): string | undefined {
    const catalogs = [...this.catalogs.values()]
    for (let index = catalogs.length - 1; index >= 0; index -= 1) {
      const hit = catalogs[index]?.[locale]?.[key]
      if (hit !== undefined) return hit
    }
    return undefined
  }
}
