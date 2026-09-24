function register(ctx, label) {
  ctx.slots.register('ui:sidebar', () => label, { priority: -2 })
}

export function apply(ctx, config) {
  const label = config?.publicConfig?.label ?? 'Agnes client service demo · v1'
  const service = ctx.agnes?.services
  if (!service) {
    register(ctx, label)
    return
  }
  void service
    .call('panel.version', {})
    .then((result) => {
      const version = result && typeof result === 'object' ? result.version : undefined
      register(ctx, typeof version === 'string' ? `${label} · backend ${version}` : `${label} · invalid`)
    })
    .catch(() => register(ctx, `${label} · unavailable`))
}
