import { webLocaleCatalog } from '@agnes/web-foundation/locale-catalog'
import { webUnitsLocaleCatalog } from '@agnes/web-units/shell'

/** Reuse the standard workbench catalogs for the shared sidebar and conversation rows. */
export function workbenchText(language: string) {
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en'
  return (key: string, vars?: Readonly<Record<string, string | number>>): string => {
    const text = webUnitsLocaleCatalog[locale][key] ?? webLocaleCatalog[locale]?.[key] ?? key
    return text.replace(/\{(\w+)\}/g, (match, name: string) => String(vars?.[name] ?? match))
  }
}
