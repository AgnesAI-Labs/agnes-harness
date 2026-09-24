// Registers its service and then throws, so the loader has to unwind a half-mounted plugin.
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
    ctx.provide('demoTextStats', Object.freeze({ engine: 'broken', label: config.label, stats: () => ({}) }))
    throw new Error('hot-service broken example: failed after registering demoTextStats')
  },
}
