import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react'
import type { LocaleCatalog, LocaleVars } from './locales/index.js'

export type UiLocale = 'en' | 'zh-CN'
export type LocaleTranslator = (key: string, vars?: LocaleVars) => string
export type { LocaleCatalog, LocaleVars } from './locales/index.js'

/** The host owns preference state; UI packages only consume this stable view. */
export interface UiLocaleSource {
  getSnapshot(): UiLocale
  getVersion(): number
  subscribe(listener: () => void): () => void
  t(key: string, vars?: LocaleVars): string
  bind(namespace: string): LocaleTranslator
}

export const UI_LOCALE_STORAGE_KEY = 'agnes-locale'

/** Adapts the host document preference for admin surfaces mounted outside the client-module locale service. */
export function createDocumentLocaleSource(
  catalogs: Readonly<Record<string, LocaleCatalog>>,
): Readonly<{ source: UiLocaleSource; dispose(): void }> {
  const readLocale = (): UiLocale => (document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en')
  let locale = readLocale()
  let version = 0
  const listeners = new Set<() => void>()
  const translate = (key: string, vars?: LocaleVars): string => {
    for (const catalog of Object.values(catalogs)) {
      const value = catalog[locale][key] ?? (locale === 'en' ? undefined : catalog.en[key])
      if (value !== undefined) return interpolate(value, vars)
    }
    return key
  }
  const refresh = (): void => {
    const next = readLocale()
    if (next === locale) return
    locale = next
    version++
    for (const listener of [...listeners]) listener()
  }
  const onStorage = (event: StorageEvent): void => {
    if (event.key === UI_LOCALE_STORAGE_KEY) refresh()
  }
  window.addEventListener('agnes:locale-changed', refresh)
  window.addEventListener('storage', onStorage)
  // The host writes `lang` after its own listeners run, so the event alone can arrive before the write.
  const observer = new MutationObserver(refresh)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })

  const source: UiLocaleSource = {
    getSnapshot: () => locale,
    getVersion: () => version,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    t: translate,
    bind: (namespace) => {
      const catalog = catalogs[namespace]
      return (key, vars) => {
        const value = catalog?.[locale][key] ?? (locale === 'en' ? undefined : catalog?.en[key])
        return value === undefined ? key : interpolate(value, vars)
      }
    },
  }

  return {
    source,
    dispose: () => {
      window.removeEventListener('agnes:locale-changed', refresh)
      window.removeEventListener('storage', onStorage)
      observer.disconnect()
      listeners.clear()
    },
  }
}

const LocaleSourceContext = createContext<UiLocaleSource | undefined>(undefined)
const noSubscribe = (): (() => void) => () => undefined
const zeroVersion = (): number => 0

export function UiLocaleProvider({
  source,
  children,
}: Readonly<{ source?: UiLocaleSource; children?: ReactNode }>): JSX.Element {
  return createElement(LocaleSourceContext.Provider, { value: source }, children ?? null)
}

/** Read translations from the mounted document source and rerender when its catalog changes. */
export function useUiText(
  namespace: string,
  fallback: LocaleCatalog,
): Readonly<{ locale: UiLocale; t: LocaleTranslator; hostT: LocaleTranslator }> {
  const source = useContext(LocaleSourceContext)
  const subscribe = source?.subscribe ?? noSubscribe
  const getVersion = source?.getVersion ?? zeroVersion
  useSyncExternalStore(subscribe, getVersion, getVersion)
  const locale = source?.getSnapshot() ?? 'en'
  const t = useMemo(
    () => createUiTranslator(source, namespace, fallback, locale),
    [fallback, locale, namespace, source],
  )
  return { locale, t, hostT: source?.t ?? t }
}

export function createUiTranslator(
  source: UiLocaleSource | undefined,
  namespace: string,
  fallback: LocaleCatalog,
  locale: UiLocale = source?.getSnapshot() ?? 'en',
): LocaleTranslator {
  const fallbackText = createCatalogTranslator(fallback, locale)
  if (!source) return fallbackText
  const boundText = source.bind(namespace)
  return (key, vars) => {
    const value = boundText(key, vars)
    return value === key ? fallbackText(key, vars) : value
  }
}

export function createCatalogTranslator(catalog: LocaleCatalog, locale: UiLocale): LocaleTranslator {
  return (key, vars) => {
    const template = catalog[locale][key] ?? (locale === 'en' ? undefined : catalog.en[key]) ?? key
    return interpolate(template, vars)
  }
}

function interpolate(template: string, vars: LocaleVars | undefined): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  )
}
