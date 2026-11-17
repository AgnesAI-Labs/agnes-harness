import type { ClientContext } from '@agnes/web-client'
import { judgmentCatalog } from './locales.js'
import { JudgmentSettings } from './settings.js'

export function apply(ctx: ClientContext) {
  const offLocale = ctx.locale.register('@agnes/judgment', judgmentCatalog)
  const offSection = ctx.settingsSections.register({
    id: 'judgment',
    group: 'plugins',
    groupTitleKey: 'judgment.group',
    titleKey: 'judgment.title',
    icon: 'puzzle',
    order: 60,
    runtimeCatalog: false,
    component: () => <JudgmentSettings client={ctx} />,
  })
  return () => {
    offSection()
    offLocale()
  }
}
