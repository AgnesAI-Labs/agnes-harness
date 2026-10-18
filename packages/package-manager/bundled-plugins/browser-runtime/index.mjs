import { fileURLToPath } from 'node:url'
import { emptySchema, observation, stream, tools } from './src/contracts.mjs'
import { BrowserEngine, binaryName } from './src/engine.mjs'
import { BrowserRuntime } from './src/runtime.mjs'

export const browserRuntime = {
  inject: ['tools', 'hooks', 'services', 'profileRuntime'],
  apply(ctx) {
    const handle = ctx.profileRuntime.register({
      id: 'browser',
      configSchema: emptySchema,
      defaultConfig: {},
      async start(init) {
        // Resolve at the package entry so both source imports and packed .mjs bundles retain the same asset root.
        const runtime = new BrowserRuntime(
          new BrowserEngine({
            binary: fileURLToPath(new URL(`./dist/bin/${binaryName()}`, import.meta.url)),
          }),
        )
        init.onShutdown(async () => {
          try {
            await runtime.dispose()
            return { state: 'settled' }
          } catch {
            return { state: 'unknown' }
          }
        })
        init.ready()
        return runtime
      },
    })
    ctx.services.register({
      ...observation,
      async handler(input, context) {
        if (!context.sessionAccess) throw new Error('Authenticated session read access is required')
        await context.sessionAccess.requireRead(input.sessionId)
        return (await handle.get()).observe(input.sessionId, context.actor)
      },
    })
    ctx.profileRuntime.streams.register(stream.name, async (input, context) => {
      ;(await handle.get()).watch(input.ticket, context)
    })
    ctx.hooks.register('shutdown', async (_payload, context) => {
      const runtime = await handle.get().catch(() => undefined)
      await runtime?.closeSession(context.session)
    })
    for (const [name, action, parameters, description] of tools) {
      const read = ['snapshot', 'tabs', 'screenshot'].includes(action)
      ctx.tools.register({
        name,
        description,
        parameters,
        meta: {
          isReadOnly: read,
          isDestructive: ['click', 'press'].includes(action),
          isConcurrencySafe: false,
          isOpenWorld: !read,
          replay: read ? 'safe' : 'never',
          costHint: {},
          deferLoading: name !== 'browser_open',
          requiresApproval: ['click', 'press'].includes(action) ? 'destructive' : 'never',
        },
        async execute(input, context) {
          try {
            const result = await (await handle.get()).execute(
              { ...input, ...(action ? { action } : {}) },
              context,
            )
            if (action === 'screenshot' && result.bytes) {
              if (!context.session.imageInput)
                throw new Error('This Host cannot provide browser screenshots to the model')
              return await context.session.imageInput({
                bytes: result.bytes,
                mimeType: 'image/png',
                name: 'browser.png',
              })
            }
            return { content: [{ type: 'text', text: JSON.stringify(result).slice(0, 60000) }] }
          } catch (error) {
            return { isError: true, content: [{ type: 'text', text: error.message }] }
          }
        },
      })
    }
  },
}
