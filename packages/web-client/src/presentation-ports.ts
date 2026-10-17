import type { PackageCatalogDescriptor, PageSessionMeta, UITurn } from '@agnes/protocol'
import type {
  ComposerHandle,
  ComposerRegionOptions,
  ConversationChildContainers,
  ConversationHandle,
  SidebarActions,
  SidebarHandle,
  SidebarState,
  TranscriptHandle,
} from '@agnes/web-units/shell'
import type { ComponentType, ReactNode } from 'react'

/** Host-owned projections/actions and mount seats. Detaching a view never cancels a session. */
export interface NavigationPresentationPort {
  container: HTMLElement
  history: NavigationHistory
  initial: { state?: SidebarState; actions?: Partial<SidebarActions>; profileApprovals?: ReactNode }
  attach(handle: SidebarHandle): () => void
}
export interface ConversationPresentationPort {
  container: HTMLElement
  onMount(children: ConversationChildContainers): void
  onUnmount(): void
  attach(handle: ConversationHandle): () => void
  transcript: {
    onFork?: (turn: UITurn) => Promise<void>
    claim?: (entry: import('@agnes/web-client').SlotEntry, extId: string) => boolean
    attach(handle: TranscriptHandle): () => void
  }
}
export interface ComposerPresentationPort {
  container: HTMLElement
  options: ComposerRegionOptions
  controls: ComposerPresentationControls
  attach(handle: ComposerHandle): () => void
}
export interface NavigationHistory {
  getSnapshot(): Readonly<{
    filter: 'unarchived' | 'archived'
    rows: readonly PageSessionMeta['items'][number][]
    status: 'idle' | 'loading' | 'error'
    error?: string
    restoring: readonly string[]
  }>
  subscribe(listener: () => void): () => void
  show(filter: 'unarchived' | 'archived'): void
  reload(): Promise<void>
  restore(sessionId: string): Promise<void>
}
export interface ComposerPresentationControls {
  LoopPicker: ComponentType
  suggestions: {
    getSnapshot(): Readonly<{ featured: readonly PackageCatalogDescriptor[]; total: number }>
    subscribe(listener: () => void): () => void
  }
}
