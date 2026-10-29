// The one package a plugin author imports: the contracts of `@agnes/extension-api` (kinds, loop
// ports, provider types, errors) beside the `define*` helpers below. A helper of the same name
// here replaces the contract package's.
export * from '@agnes/extension-api'
export {
  defineChildAgentProvider,
  defineCompactionEngine,
  definePersistenceProvider,
  defineProvider,
  defineSandboxProvider,
  defineToolPolicy,
  defineToolRuntime,
} from './author/providers.js'
export type {
  AgnesPlugin,
  Context,
  Inject,
  Plugin,
  ProviderPluginContext,
  TypedToolDef,
  TypedToolResult,
} from './author.js'
export {
  defineAgnesPlugin,
  defineLoop,
  defineModelAdapter,
  defineTool,
  readOnlyTool,
  toolCancelled,
  toolError,
  writeTool,
} from './author.js'

export { drainDeferredToolInvocations, withDeferredToolInvocations } from './deferred-invocations.js'
export type { WorkflowData, WorkflowOptions, WorkflowStage, WorkflowState } from './workflow/index.js'
export {
  defineWorkflowLoop,
  workflowChecked,
  workflowModelText,
  workflowResult,
  workflowText,
  workflowTool,
  workflowValue,
} from './workflow/index.js'
