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
import type { VoicePort } from './voice-port.js'

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
    /** Present when the host offers voice: the final reply shows a read-aloud button. */
    voice?: VoicePort
    attach(handle: TranscriptHandle): () => void
  }
}
export interface ComposerPresentationPort {
  container: HTMLElement
  options: ComposerRegionOptions
  controls: ComposerPresentationControls
  attach(handle: ComposerHandle): () => void
}
/** Which sessions the sidebar lists; older hosts only know the first and last. */
export type SessionListMode = 'active' | 'all' | 'archived'

export interface NavigationHistory {
  getSnapshot(): Readonly<{
    /** Compatibility field, derived from `mode`: several plugins still read the two-state filter. */
    filter: 'unarchived' | 'archived'
    /** Absent on hosts that predate the three-state filter; the UI derives it from `filter`. */
    mode?: SessionListMode
    rows: readonly PageSessionMeta['items'][number][]
    status: 'idle' | 'loading' | 'error'
    error?: string
    restoring: readonly string[]
  }>
  subscribe(listener: () => void): () => void
  show(filter: 'unarchived' | 'archived'): void
  /** Optional so a host without the three-state filter still implements this port. */
  setMode?(mode: SessionListMode): void
  /** Optional: reads the whole session list once, which the flat list and mixed views need. */
  ensureLoaded?(): Promise<void>
  reload(): Promise<void>
  restore(sessionId: string): Promise<void>
}
export interface ComposerPresentationControls {
  LoopPicker: ComponentType
  suggestions: {
    getSnapshot(): Readonly<{ featured: readonly PackageCatalogDescriptor[]; total: number }>
    subscribe(listener: () => void): () => void
  }
  /** Present when the host offers voice: the composer shows the mic and conversation buttons. */
  voice?: VoicePort
}
