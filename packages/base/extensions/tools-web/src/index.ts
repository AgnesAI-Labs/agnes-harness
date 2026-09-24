import { defineExtension } from '@agnes/extension-api'
import { webFetchTool } from './fetch.js'

export const TOOLS_WEB = [webFetchTool] as const
export default defineExtension((agnes) => agnes.registerTool(webFetchTool))
