import { type MemoryProvider, memoryKind, type ProviderPluginContext } from '@agnes/extension-api'
import { openMemory } from './session.js'

export type { AuditEntry } from './audit.js'
export { appendAudit, readAuditEntries } from './audit.js'
export { chunkView } from './chunker.js'
export {
  formatLifecycleOmission,
  inspectConsistency,
  rebuildConsistencyIndex,
  registerLifecycle,
} from './consistency.js'
export { defaults as FILE_MEMORY_DEFAULTS } from './content.js'
export { expiryNextExpiry, expiryViewFilter } from './expiry-annotation.js'
export { humanGuard } from './human-guard.js'
export { MetaStore } from './meta.js'
export { roots as fileMemoryRoots } from './paths.js'
export type {
  CloseHook,
  CommitGuard,
  CommitIntent,
  CommitObserver,
  GuardVerdict,
  MemoryClock,
  MemoryPipeline,
  NextExpiryProvider,
  RecallEnvironment,
  RecallHandler,
  ViewContext,
  ViewFilter,
} from './pipeline.js'
export { createDefaultPipeline, createPipeline, retrievalOf } from './pipeline.js'
export { preferenceConflictGuard, registerMemoryProtection } from './preference-conflict.js'
export { attributedBlocks, memoryBlocks, provenanceObserver } from './provenance.js'
export type { RetrievalHandle } from './recall.js'
export { registerRetrieval } from './recall.js'
export { refViewFilter } from './ref-filter.js'
export { readDocuments, SearchIndex } from './search-index.js'
export type { OpenMemoryInput } from './session.js'
export { inspectMemoryConsistency, openMemory, rebuildMemoryIndex } from './session.js'
export { topicLinksObserver, topicLinksViewFilter } from './topic-links.js'
export type { HideRange, MarkerSpan, MemoryView, Segment } from './view.js'
export {
  buildView,
  mapViewOffsetToRaw,
  mapViewSpanToRawLines,
  rawOffsetToLine,
  replaceInMemoryView,
} from './view.js'

/** Official plugin implementation. Host passes the home and authoritative workspace at session open. */
export const fileMemoryProvider: MemoryProvider = Object.freeze({
  id: 'file',
  version: '1.0.0',
  open: openMemory,
})

export const memoryPlugin = {
  inject: ['providers'],
  apply(ctx: ProviderPluginContext) {
    ctx.providers.register(memoryKind, fileMemoryProvider)
  },
}
