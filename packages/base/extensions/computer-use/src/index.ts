import type { Disposer } from '@agnes/extension-api'
import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import type { ComputerUseBackendProvider } from './backend.js'
import { type ComputerUseToolOptions, ComputerUseToolRuntime } from './tool.js'

export * from './backend.js'
export * from './parse.js'
export * from './policy.js'
export * from './result.js'
export * from './safety.js'
export * from './schema.js'
export * from './tool.js'

export function createComputerUseExtension(
  provider: ComputerUseBackendProvider,
  options?: ComputerUseToolOptions,
) {
  return defineAgnesPlugin({
    inject: ['tools', 'hooks'],
    apply(ctx: Context) {
      const runtime = new ComputerUseToolRuntime(provider, options)
      const unregister = ctx.tools.register(runtime.tool)
      const unregisterCompact = ctx.hooks.register('compact', (_payload, context) => {
        runtime.resetScreenshotDedup(context.session)
      })
      const unregisterShutdown = ctx.hooks.register('shutdown', async (_payload, context) => {
        runtime.resetSession(context.session)
        await provider.release?.(context.session)
      })
      const dispose: Disposer = () => {
        unregisterShutdown()
        unregisterCompact()
        unregister()
        runtime.clear()
        // The provider's lifecycle is the caller's (the Host owns the lazy runtime and disposes it at
        // host close; see backend.ts "Host-owned lifecycle hooks"). A row teardown must never close
        // the shared runtime for the whole Host.
      }
      return dispose
    },
  })
}

/** P0 gate: the package manifest deliberately does not load this entry until Host injects a trusted provider. */
export default defineAgnesPlugin({
  apply() {
    throw new Error('computer-use extension requires the Host-owned backend provider')
  },
})
