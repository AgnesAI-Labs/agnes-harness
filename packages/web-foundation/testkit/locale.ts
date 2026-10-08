import { Context } from '@agnes/cordis'
import { LocaleService } from '@agnes/web-client'
import type { Translate } from '@agnes/web-ui'
import { webUiLocaleCatalog } from '../../web-ui/src/locales/index.js'
import { WEB_UNITS_LOCALE_NAMESPACE, webUnitsLocaleCatalog } from '../../web-units/src/locales/index.js'
import { webLocaleCatalog } from '../src/locale-catalog.js'

/** 与 boot 相同的宿主目录并集，供测试查词与注册。 */
const ALL_CATALOGS = [webLocaleCatalog, webUnitsLocaleCatalog, webUiLocaleCatalog] as const

/** 与 LocaleService 同款的目录查词 + 插值；测试断言目录结果而不是字面量。 */
function catalogT(locale: 'en' | 'zh-CN'): Translate {
  return (key, vars) => {
    let template: string | undefined
    for (const catalog of ALL_CATALOGS) {
      const dictionary = catalog[locale] ?? {}
      const english = catalog.en ?? {}
      template ??=
        (Object.hasOwn(dictionary, key) ? dictionary[key] : undefined) ??
        (Object.hasOwn(english, key) ? english[key] : undefined)
    }
    template ??= key
    if (!vars) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.hasOwn(vars, name) ? String(vars[name]) : match,
    )
  }
}

export const zhT: Translate = catalogT('zh-CN')
export const enT: Translate = catalogT('en')

/** 带全部宿主目录的 zh-CN LocaleService，供命令式渲染器（timeline 等）在测试里取词。 */
export function zhLocaleService(context: Context = new Context()): LocaleService {
  const locale = new LocaleService(context, 'zh-CN')
  locale.register('@agnes/web', webLocaleCatalog)
  locale.register(WEB_UNITS_LOCALE_NAMESPACE, webUnitsLocaleCatalog)
  locale.register('@agnes/web-ui', webUiLocaleCatalog)
  return locale
}
