export type { SystemInput, SystemInputPresentation } from '@agnes/protocol'
// `@agnes/extension-api` author API version (independent semver). Compare the manifest `apiRange`
// against it; a mismatch yields `E_API_RANGE`.

export * from './api-range.js'
export * from './attachments.js'
export * from './child-agent.js'
export type * from './child-control.js'
export * from './common.js'
export type {
  CompactionBudget,
  CompactionEngine,
  CompactionEngineCatalogEntry,
  CompactionEngineInstance,
  CompactionInput,
  CompactionModelPort,
  CompactionNode,
  CompactionOutput,
  CompactionReplacement,
} from './compaction-engine.js'
export { createCompactionThreshold } from './compaction-engine.js'
export * from './decisions.js'
export * from './errors.js'
export * from './extension.js'
export { HOOK_TABLE } from './generated/hook-table.js'
export { SLOT_TABLE } from './generated/slot-table.js'
export * from './hooks.js'
export * from './kinds.js'
export * from './loop.js'
export * from './loop-events.js'
export * from './managed-services.js'
export * from './manifest.js'
export * from './memory.js'
export * from './model-adapter.js'
export * from './persistence.js'
export * from './plugin-config.js'
export * from './plugin-context.js'
export * from './process.js'
export * from './profile-runtime.js'
export * from './profile-services.js'
export * from './projections.js'
export * from './provider-kind.js'
export type {
  ReferenceCandidate,
  ReferenceContext,
  ReferenceLimits,
  ReferenceResolver,
  ReferenceResolverPort,
  ReferenceSearchResult,
  ReferenceSelection,
  ResolvedReference,
} from './reference-resolver.js'
export type { RemoteTransport } from './remote-transport.js'
export * from './resources.js'
export * from './sandbox-provider.js'
export * from './scheduling.js'
export * from './search-provider.js'
export * from './service-provider.js'
export * from './services.js'
export * from './side-call.js'
export * from './skill-install.js'
export * from './slots.js'
export * from './streams.js'
export {
  type ModelAdapterAttemptObservation,
  type ModelRequestTrace,
  type ModelRequestTraceHandle,
  type SystemPromptProvider,
  systemPromptKind,
} from './system-prompt.js'
export * from './tool.js'
export * from './tool-policy.js'
export * from './tool-references.js'
export * from './tool-runtime.js'
export * from './version.js'
export * from './webhook-trigger.js'
export * from './workspace-hooks.js'

export * from './workspace-state.js'
