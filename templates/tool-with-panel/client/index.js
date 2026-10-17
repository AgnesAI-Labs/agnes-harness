export function apply(ctx, config) {
  ctx.homeEntries.register({
    id: '__SKILL_NAME__',
    icon: 'plugin',
    titleKey: '__PACKAGE_NAME__',
    order: 50,
    placement: 'secondary',
    component: function PluginPage() {
      const zh = ctx.locale.locale === 'zh-CN'
      return (
        (config?.publicConfig?.label ?? '__PACKAGE_NAME__') +
        (zh ? '：请智能体调用 __TOOL_NAME__' : ': ask the agent to call __TOOL_NAME__')
      )
    },
  })
}
