export function apply(ctx) {
  ctx.homeEntries.register({
    id: 'acme-overview',
    icon: 'plugin',
    titleKey: 'Acme',
    order: 10,
    placement: 'primary',
    component() {
      return ctx.locale.locale === 'zh-CN'
        ? '模拟签署应用 · 使用快捷操作验证宿主业务确认。'
        : 'Synthetic signature application · Use the quick action to exercise Host business consent.'
    },
  })
}
