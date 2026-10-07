import type { Context, Inject, Plugin } from '@agnes/cordis'
import './author/context.js'

/** A standard Cordis plugin accepted by the Agnes package loader. */
export type AgnesPlugin<Config = unknown> = Plugin<Config>

/** Preserve the plugin's complete inferred Cordis shape without a runtime wrapper. */
export function defineAgnesPlugin<P extends Plugin>(plugin: P): P {
  return plugin
}

export type { Context, Inject, Plugin }

export { defineTool, toolCancelled, toolError } from './author/tool.js'
export type { TypedToolDef, TypedToolResult } from './author/tool.js'
export { defineLoop } from './author/loop.js'
export { defineModelAdapter } from './author/model-adapter.js'
export type { LoopPluginContext, ModelAdapterPluginContext } from './author/context.js'
