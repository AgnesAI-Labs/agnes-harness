export function apply(ctx, config) {
  ctx.slots.register(
    'ui:sidebar',
    function PluginPanel() {
      return (config?.publicConfig?.label ?? '__PACKAGE_NAME__') + ': ask the agent to call __TOOL_NAME__'
    },
    { priority: -1 },
  )
}
