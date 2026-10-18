const VERSION = 'v1'

export function apply(ctx, config) {
  ctx.slots.register('workbench.panel', function ClientPanelV1() {
    return config?.publicConfig?.label ?? `Agnes client module demo · ${VERSION}`
  })
}
