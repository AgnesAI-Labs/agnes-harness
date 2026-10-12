import type { Context as CordisContext, Inject, Plugin } from '@agnes/cordis'
import type { ProviderPluginContext } from '@agnes/extension-api'
import './author/context.js'
export type Context = CordisContext & ProviderPluginContext
export type { ProviderPluginContext } from '@agnes/extension-api'

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
