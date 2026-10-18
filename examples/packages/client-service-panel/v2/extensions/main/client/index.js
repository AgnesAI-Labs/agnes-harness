/** Wait for a binding, and never publish a result from an older session epoch. */
export function apply(ctx, config) {
  const label = config?.publicConfig?.label ?? 'Agnes client service demo · v2'
  let live = true
  let remove = () => {}
  const refresh = () => {
    const snapshot = ctx.session.readiness.getSnapshot()
    remove()
    remove = () => {}
    if (snapshot.status !== 'ready') return
    const current = () =>
      live &&
      ctx.session.readiness.getSnapshot() === snapshot &&
      (!ctx.availability.getSnapshot() || ctx.availability.getSnapshot().availability === 'active')
    void ctx.agnes.services.call('panel.version', {}).then(
      (result) => {
        if (!current()) return
        const version = result && typeof result === 'object' ? result.version : undefined
        remove = ctx.slots.register('workbench.panel', () => `${label} · backend ${version ?? 'invalid'}`)
      },
      () => {
        if (current()) remove = ctx.slots.register('workbench.panel', () => `${label} · unavailable`)
      },
    )
  }
  const off = ctx.session.readiness.subscribe(refresh)
  ctx.effect(() => () => {
    live = false
    off()
    remove()
  })
  refresh()
}
