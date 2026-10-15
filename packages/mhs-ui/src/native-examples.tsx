import type { ClientContext } from '@agnes/web-client'
import type { ExamplesPort } from './ports.js'
/** Installation and scene registration are separate from managed-runtime readiness. */
export function nativeExamples(ctx: ClientContext): ExamplesPort {
  return {
    async list(signal) {
      const examples = await ctx.profile.examples.list()
      signal.throwIfAborted()
      return examples.map((example) => ({
        id: example.id,
        name: example.metadata.displayName,
        description: example.metadata.description,
        state:
          example.installation === 'enabled'
            ? 'installed'
            : example.installation === 'enabling'
              ? 'starting'
              : example.installation === 'failed'
                ? 'failed'
                : 'disabled',
        Scene: () =>
          ctx.examplePages.render(example.id, {
            t: (key, vars) => ctx.locale.t(key, vars),
            session: ctx.session,
          }),
      }))
    },
    subscribe: ctx.examplePages.subscribe,
    async inspect(id) {
      const review = await ctx.profile.examples.inspect(id)
      return { reviewId: review.reviewId, presentation: review.presentation }
    },
    async enable(_id, reviewId) {
      if (!reviewId) throw new Error('example-review-required')
      await ctx.profile.examples.enable(reviewId, crypto.randomUUID())
    },
    async stop() {
      throw new Error('example-runtime-unavailable')
    },
    async prepare(id) {
      const example = (await ctx.profile.examples.list()).find((example) => example.id === id)
      const launchId = example?.metadata.launches?.[0]?.id
      if (!launchId) throw new Error('example-launch-unavailable')
      return ctx.profile.launch.prepare(id, launchId)
    },
    async launch(_id, launchTicket) {
      if (!launchTicket) throw new Error('example-launch-review-required')
      await ctx.profile.launch.start(launchTicket, crypto.randomUUID())
    },
  }
}
