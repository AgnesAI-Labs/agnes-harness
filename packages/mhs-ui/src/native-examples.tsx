import type { ClientContext } from '@agnes/web-client'
import type { ExamplesPort, ExampleView } from './ports.js'
/** Installation, operation receipts and scene registration are distinct readiness facts. */
export function nativeExamples(ctx: ClientContext): ExamplesPort {
  const operations = new Map<string, string>()
  return {
    async list(signal) {
      const examples = await ctx.profile.examples.list()
      return Promise.all(
        examples.map(async (example): Promise<ExampleView> => {
          signal.throwIfAborted()
          let state: ExampleView['state'] =
              example.installation === 'enabled'
                ? 'installed'
                : example.installation === 'enabling'
                  ? 'starting'
                  : example.installation === 'failed'
                    ? 'failed'
                    : 'disabled',
            code: string | undefined
          const operation = operations.get(example.id)
          if (operation) {
            const receipt = await ctx.profile.examples.read(operation)
            signal.throwIfAborted()
            if (receipt.state === 'completed') operations.delete(example.id)
            else if (receipt.state === 'running') state = 'starting'
            else {
              state = 'failed'
              code = receipt.code ?? receipt.state
            }
          }
          const context = {
            t: (key: string, vars?: Readonly<Record<string, string | number>>) => ctx.locale.t(key, vars),
            session: ctx.session,
          }
          return {
            id: example.id,
            name: example.metadata.displayName,
            description: example.metadata.description,
            state,
            ...(code ? { code } : {}),
            ...(ctx.examplePages.render(example.id, context)
              ? { Scene: () => ctx.examplePages.render(example.id, context) }
              : {}),
          }
        }),
      )
    },
    subscribe: ctx.examplePages.subscribe,
    async inspect(id) {
      operations.delete(id)
      const review = await ctx.profile.examples.inspect(id)
      return { reviewId: review.reviewId, presentation: review.presentation }
    },
    async enable(id, reviewId) {
      if (!reviewId) throw new Error('example-review-required')
      const operation = await ctx.profile.examples.enable(reviewId, crypto.randomUUID())
      operations.set(id, operation.operationId)
    },
    async stop() {
      throw new Error('example-runtime-unavailable')
    },
    async prepare(id) {
      const example = (await ctx.profile.examples.list()).find((e) => e.id === id),
        launchId = example?.metadata.launches?.[0]?.id
      if (!launchId) throw new Error('example-launch-unavailable')
      return ctx.profile.launch.prepare(id, launchId)
    },
    async launch(_id, launchTicket) {
      if (!launchTicket) throw new Error('example-launch-review-required')
      return ctx.profile.launch.start(launchTicket, crypto.randomUUID())
    },
  }
}
