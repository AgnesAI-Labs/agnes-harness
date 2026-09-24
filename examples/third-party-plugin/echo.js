/** Minimal third-party plugin: a Cordis-style export with no Host internals. */
export function echo(ctx, config) {
  ctx.provide('ext:example/echo', Object.freeze({ message: config?.message ?? 'ok' }))
}
echo.Config = {
  '~standard': {
    version: 1,
    vendor: 'example',
    validate(value) {
      return { value }
    },
  },
}
echo.provide = 'ext:example/echo'
