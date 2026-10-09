/** Synthetic local plugin; no credential resolution or external calls. */
export const agent = {
  provide: ['e2eConfigAgent'],
  apply(ctx, config) {
    if (config?.name === 'refuse') throw new Error('Synthetic configuration refusal')
    ctx.provide('e2eConfigAgent', Object.freeze({ ...config }))
  },
}
