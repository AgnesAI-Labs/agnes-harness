import { type Context, Service } from '@agnes/cordis'
import { notifyListeners } from '@agnes/sdk/browser'
import { applicationBrand, applicationIdentity } from './application-identity.js'

export const UI_LOCALES = ['en', 'zh-CN'] as const
export type UiLocale = (typeof UI_LOCALES)[number]

export function resolveUiLocale(value: string | null | undefined): UiLocale {
  return (UI_LOCALES as readonly string[]).includes(value ?? '') ? (value as UiLocale) : 'en'
}

/** Text for one locale: message keys mapped to translated values. */
export type LocaleDictionary = Record<string, string>

/** `ctx.locale.register` catalog: register `en` and `zh-CN` under the same namespace. */
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
    ctx.effect(() =>
      applicationIdentity.subscribe(() => notifyListeners(this.listeners, 'application identity')),
    )
    this.currentLocale = resolveUiLocale(initial)
  }

  get locale(): UiLocale {
    return this.currentLocale
  }

  /** Register a catalog under the package id namespace. Revocation removes it; plugin effects bind it to the fiber. */
  register(namespace: string, catalog: LocaleCatalog): () => void {
    // Re-registering a namespace is an update, not a second competing seat.
    // Delete first so the newest revision wins deterministic lookup order.
    this.catalogs.delete(namespace)
    this.catalogs.set(namespace, catalog)
    notifyListeners(this.listeners, 'locale')
    return () => {
      if (this.catalogs.get(namespace) !== catalog) return
      this.catalogs.delete(namespace)
      notifyListeners(this.listeners, 'locale')
    }
  }

  /**
   * Look up catalog text: later registrations override earlier ones.
   * Missing keys fall back from the current locale to English, then to the key itself.
   */
  t(key: string, vars?: LocaleVars): string {
    if (key === 'brand.agent') return applicationBrand(this.currentLocale).assistantName
    if (key === 'brand.harness') return applicationBrand(this.currentLocale).name
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

  /** Host-only call. Unknown locales fall back to English. */
  setLocale(locale: string): void {
    const next = resolveUiLocale(locale)
    if (next === this.currentLocale) return
    this.currentLocale = next
    notifyListeners(this.listeners, 'locale')
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
