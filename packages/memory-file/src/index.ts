import { type MemoryProvider, memoryKind, type ProviderPluginContext } from '@agnes/extension-api'
import { openMemory } from './session.js'

export { defaults as FILE_MEMORY_DEFAULTS } from './content.js'
export { roots as fileMemoryRoots } from './paths.js'
export { openMemory } from './session.js'

/** Official plugin implementation. Host passes the home and authoritative workspace at session open. */
export const fileMemoryProvider: MemoryProvider = Object.freeze({
  id: 'file',
  version: '1.0.0',
  open: openMemory,
})

export const memoryPlugin = {
  inject: ['providers'],
  apply(ctx: ProviderPluginContext) {
    ctx.providers.register(memoryKind, '@agnes/base', fileMemoryProvider)
  },
}
