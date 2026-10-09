// `@agnes/extension-api` 的作者面版本号（规格 §19，独立 semver）。清单 `apiRange` 与它比对，
// 不合判 `E_API_RANGE`。

export * from './api-range.js'
export * from './child-agent.js'
export type * from './child-control.js'
export * from './common.js'
export type {
  CompactionBudget,
  CompactionEngine,
  CompactionEngineCatalogEntry,
  CompactionEngineInstance,
  CompactionEnginePluginContext,
  CompactionEngineRegistration,
  CompactionInput,
  CompactionModelPort,
  CompactionNode,
  CompactionOutput,
  CompactionReplacement,
} from './compaction-engine.js'
export { createCompactionThreshold } from './compaction-engine.js'
export * from './errors.js'
export * from './extension.js'
export { HOOK_TABLE } from './generated/hook-table.js'
export { SLOT_TABLE } from './generated/slot-table.js'
export * from './hooks.js'
export * from './loop.js'
export * from './loop-events.js'
export * from './loop-plugin.js'
export * from './manifest.js'
export * from './memory.js'
export * from './model-adapter.js'
export * from './observability.js'
export * from './persistence.js'
export * from './plugin-extension.js'
export * from './process.js'
export * from './projections.js'
export * from './provider-kind.js'
export type {
  ReferenceCandidate,
  ReferenceSearchResult,
  ReferenceSelection,
  ReferenceContext,
  ReferenceLimits,
  ReferenceResolver,
  ReferenceResolverPort,
  ResolvedReference,
} from './reference-resolver.js'
export * from './resources.js'
export * from './sandbox-provider.js'
export * from './search-provider.js'
export * from './services.js'
export * from './skill-install.js'
export * from './slots.js'
export {
  type ModelAdapterAttemptObservation,
  type ModelRequestTrace,
  type ModelRequestTraceHandle,
  type SystemPromptProvider,
  systemPromptKind,
} from './system-prompt.js'
export * from './tool.js'
export * from './tool-policy.js'
export * from './tool-runtime.js'
export * from './version.js'
export * from './webhook-trigger.js'
export * from './workspace-hooks.js'
export * from './feedback.js'

export * from './plugin-config.js'

export type { RemoteTransport } from './remote-transport.js'

export * from './deferred-invocations.js'
