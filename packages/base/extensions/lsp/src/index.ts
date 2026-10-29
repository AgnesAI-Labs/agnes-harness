import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import type { LspConfig } from './config.js'
import { type LspSessions, standaloneLsp } from './registry.js'
import { createLspDiagnosticsTool } from './tool.js'

export type { LspConfig } from './config.js'
export { LspSessions, lspFor, standaloneLsp } from './registry.js'

// Applying this extension is what switches language servers on: until then the registry shared with
// tools-core is inactive and write/edit start nothing. A bundled plugin is applied without a
// per-plugin config object, so the defaults of `LspConfig` are what runs; `config` is for tests and
// for a Host that wants to pass its own.
export function createLspExtension(lsp: LspSessions = standaloneLsp, config: Partial<LspConfig> = {}) {
  return defineAgnesPlugin({
    inject: ['tools', 'hooks'],
    apply(plugin: Context) {
      lsp.configure(config)
      const disposers = [
        plugin.tools.register(createLspDiagnosticsTool(lsp)),
        plugin.hooks.register('shutdown', async (_payload, ctx) => {
          await lsp.closeSession(ctx.session.key, ctx.session.lane)
        }),
      ]
      return async () => {
        for (const dispose of disposers) dispose()
        await lsp.dispose()
      }
    },
  })
}
export default createLspExtension()
