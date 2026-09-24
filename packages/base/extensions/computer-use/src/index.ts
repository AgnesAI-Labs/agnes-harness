import { type Disposer, defineExtension } from '@agnes/extension-api'
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
  return defineExtension((agnes) => {
    const runtime = new ComputerUseToolRuntime(provider, options)
    const unregister = agnes.registerTool(runtime.tool)
    const unregisterCompact = agnes.registerHook('compact', (_payload, context) => {
      runtime.resetScreenshotDedup(context.session)
    })
    const unregisterShutdown = agnes.registerHook('shutdown', async (_payload, context) => {
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
  })
}

/** P0 gate: the package manifest deliberately does not load this entry until Host injects a trusted provider. */
export default defineExtension(() => {
  throw new Error('computer-use extension requires the Host-owned backend provider')
})
