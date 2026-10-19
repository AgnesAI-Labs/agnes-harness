import { homeNavigation } from '@agnes/web-client'
import { Banner, Button, PageHeader } from '@agnes/web-ui'
import React from 'react'
import { Configuration, Mrb, Zeroing } from './governance.js'
import { language, titles } from './i18n.js'
import { useProgramme } from './operations.js'
import { Home, Requirements, Tests } from './views.js'

const h = React.createElement
const views = {
  'aero-home': Home,
  'aero-requirements': Requirements,
  'aero-tests': Tests,
  'aero-mrb': Mrb,
  'aero-configuration': Configuration,
  'aero-zeroing': Zeroing,
}
export function apply(ctx, config) {
  ctx.locale.register('@agnes-showcase/aerospace-quality', {
    en: Object.fromEntries(Object.entries(titles).map(([id, values]) => [`aero.nav.${id}`, values[1]])),
    'zh-CN': Object.fromEntries(Object.entries(titles).map(([id, values]) => [`aero.nav.${id}`, values[0]])),
  })
  for (const id of Object.keys(titles)) {
    function ProgrammePage() {
      const locale = React.useSyncExternalStore(ctx.locale.subscribe, () => ctx.locale.locale)
      const t = language(locale)
      const op = useProgramme(ctx, config, t)
      return h(
        'main',
        { className: 'aero-app', 'data-aero-page': id },
        h(
          'div',
          { className: 'aero-programme' },
          h('span', null, 'QV-X27 / PVD'),
          h('span', null, t.synthetic),
          h('span', null, op.data ? `${t.choose('修订', 'Revision')} ${op.data.revision}` : '—'),
        ),
        h(PageHeader, {
          title: t.title(id),
          description: t.description,
          actions: h(Button, { onClick: op.refresh, disabled: op.busy }, t.refresh),
        }),
        op.error && h(Banner, { tone: 'error' }, op.error),
        op.message && h(Banner, { tone: op.pending ? 'warning' : 'info' }, op.message),
        op.pending &&
          h(
            'div',
            { className: 'aero-pending' },
            h('code', null, op.pending.operationId),
            h(Button, { disabled: op.busy, onClick: () => op.check() }, t.check),
          ),
        !op.data
          ? h(
              'p',
              { role: 'status' },
              op.busy
                ? t.loading
                : t.choose('数据未加载，请刷新重试。', 'Data unavailable; refresh to retry.'),
            )
          : h(views[id], { data: op.data, t, op, ctx, navigate: (next) => homeNavigation.open(next) }),
        h(
          'footer',
          { className: 'aero-footer' },
          t.choose(
            'ECSS · AS9100D · NASA-STD-8739 · NPR 7120.5 · GJB 9001C · 双五条归零 / 概念演示，无认证声明',
            'ECSS · AS9100D · NASA-STD-8739 · NPR 7120.5 · GJB 9001C · Double-five zeroing / Conceptual demonstration, no certification claim',
          ),
        ),
      )
    }
    ctx.homeEntries.register({
      id,
      titleKey: `aero.nav.${id}`,
      icon: ['activity', 'list', 'monitor', 'shield', 'settings', 'check'][Object.keys(titles).indexOf(id)],
      order: Object.keys(titles).indexOf(id) + 10,
      placement: 'primary',
      component: ProgrammePage,
    })
  }
}
