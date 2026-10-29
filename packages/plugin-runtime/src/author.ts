import type { Context as CordisContext, Inject, Plugin } from '@agnes/cordis'
import type { PluginContextFacets } from '@agnes/extension-api'
import './author/context.js'
/** What `apply` receives: the Cordis context plus the Host-supplied facets the plugin lists in `inject`. */
export type Context = CordisContext & PluginContextFacets
export type { PluginContextFacets, ProviderPluginContext } from '@agnes/extension-api'

/** A standard Cordis plugin accepted by the Agnes package loader. */
export type AgnesPlugin<Config = unknown> = Plugin<Config>

/** Preserve the plugin's complete inferred Cordis shape without a runtime wrapper. */
export function defineAgnesPlugin<P extends Plugin>(plugin: P): P {
  return plugin
}

export {
  childAgentKind,
  compactionKind,
  type DecisionHandle,
  type DecisionPort,
  type DecisionSpec,
  defineKind,
  loopKind,
  memoryKind,
  modelAdapterKind,
  persistenceKind,
  referenceResolverKind,
  type ServiceInstance,
  type ServicePorts,
  sandboxKind,
  systemPromptKind,
  toolPolicyKind,
  toolRuntimeKind,
  webhookTriggerKind,
} from '@agnes/extension-api'
export { defineLoop } from './author/loop.js'
export { defineModelAdapter } from './author/model-adapter.js'
export {
  defineChildAgentProvider,
  defineCompactionEngine,
  definePersistenceProvider,
  defineProvider,
  defineSandboxProvider,
  defineToolPolicy,
  defineToolRuntime,
} from './author/providers.js'
export type { TypedToolDef, TypedToolResult } from './author/tool.js'
export { defineTool, readOnlyTool, toolCancelled, toolError, writeTool } from './author/tool.js'
export type { Inject, Plugin }
