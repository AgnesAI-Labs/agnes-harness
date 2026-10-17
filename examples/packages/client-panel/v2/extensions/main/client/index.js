const VERSION = 'v2'

export function apply(ctx, config) {
  ctx.slots.register('workbench.panel', function ClientPanelV2() {
    return config?.publicConfig?.label ?? `Agnes client module demo · ${VERSION}`
  })
}
