export function apply(ctx, config) {
  ctx.slots.register('ui:sidebar', () => config.publicConfig?.label ?? 'Agnes multi row · secondary', {
    priority: -4,
  })
}
