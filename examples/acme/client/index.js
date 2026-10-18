export function apply(ctx) {
  ctx.homeEntries.register({
    id: 'acme-overview',
    icon: 'plugin',
    titleKey: 'Acme',
    order: 10,
    placement: 'primary',
    component() {
      return ctx.locale.locale === 'zh-CN'
        ? 'Acme 运营台 · 在智能体页选择 Acme 运营助手。状态为模拟数据，执行工具不访问客户系统。'
        : 'Acme Operations · Choose Acme operations on the Agents page. Status is synthetic; the tool does not contact customer systems.'
    },
  })
}
