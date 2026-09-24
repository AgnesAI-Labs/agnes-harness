const VERSION = 'v1'

export function apply(ctx, config) {
  ctx.slots.register(
    'ui:sidebar',
    function ClientPanelV1() {
      return config?.publicConfig?.label ?? `Agnes client module demo · ${VERSION}`
    },
    { priority: -1 },
  )
}
