import { defineExtension, type SearchProvider } from '@agnes/extension-api'
import { webFetchTool } from './fetch.js'
import { createWebSearchTool, webSearchTool } from './search.js'

export const TOOLS_WEB = [webFetchTool, webSearchTool] as const
export function createToolsWebExtension(provider?: SearchProvider) {
  return defineExtension((agnes) => {
    const disposers = [webFetchTool, createWebSearchTool(provider)].map((tool) => agnes.registerTool(tool))
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}
export default createToolsWebExtension()
