import type { SearchProvider } from '@agnes/extension-api'
import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { webFetchTool } from './fetch.js'
import { createWebSearchTool, webSearchTool } from './search.js'

export const TOOLS_WEB = [webFetchTool, webSearchTool] as const
export function createToolsWebExtension(provider?: SearchProvider) {
  return defineAgnesPlugin({
    inject: ['tools'],
    apply(ctx: Context) {
      const disposers = [webFetchTool, createWebSearchTool(provider)].map((tool) => ctx.tools.register(tool))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
  })
}
export default createToolsWebExtension()
