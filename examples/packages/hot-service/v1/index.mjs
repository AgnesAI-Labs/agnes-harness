// A plain Cordis object plugin: no imports, so the installed snapshot needs no dependency.
// It provides one service, `demoTextStats`, that other plugins can `inject`.
const Config = {
  '~standard': {
    version: 1,
    vendor: 'agnes-example',
    validate(value) {
      const input = value === undefined ? {} : value
      if (typeof input !== 'object' || input === null || Array.isArray(input))
        return { issues: [{ message: 'config must be an object' }] }
      const label = input.label
      if (label !== undefined && typeof label !== 'string')
        return { issues: [{ message: 'label must be a string' }] }
      return { value: { label: label === undefined ? 'demo' : label.trim() || 'demo' } }
    },
  },
}

export const hotService = {
  Config,
  provide: 'demoTextStats',
  apply(ctx, config) {
    ctx.provide(
      'demoTextStats',
      Object.freeze({
        engine: 'v1',
        label: config.label,
        stats(text) {
          const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length
          return { characters: text.length, words }
        },
      }),
    )
  },
}
