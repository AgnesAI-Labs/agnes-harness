export function apply(ctx, config) {
  ctx.slots.register('workbench.panel', () => config.publicConfig?.label ?? 'Agnes multi row · primary v2', {
    priority: 0,
  })
}
