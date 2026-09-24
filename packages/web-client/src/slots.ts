/** Public slot contracts. The ledger implementation lives in @agnes/web-slots. */

import type { UINode, WebClientModuleSlotName } from '@agnes/protocol'
import type {
  ChainSelection,
  SlotSpec as CoreSlotSpec,
  LiveSlotNode,
  SlotChildren,
  SlotCore,
  SlotKind,
  SlotLabel,
  SlotScope,
  StoredEntry,
  StoreInstance,
} from '@agnes/web-slots'
import type { ComponentType } from 'react'
import type { DshSlotName } from './dsh-slot-catalog.js'
import type { ClientDocumentArtifact, ClientResourceService } from './services.js'

export interface ToolCardInlineProps {
  fill: SlotFillView
}
export interface ClientCardProps {
  kind: string
  data: unknown
  producer?: ModuleRevision
}
export interface WorkbenchPanelProps {
  sessionId?: string
}
export interface SlotFillView {
  slot: string
  extId: string
  payload: unknown
}
export interface ModuleRevision {
  packageId: string
  revision: string
}

export interface LegacySlotMap {
  'tool.card.inline': ToolCardInlineProps
  'client.card': ClientCardProps
  'workbench.panel': WorkbenchPanelProps
}

/**
 * Common props supplied to a DSH-aligned position.
 *
 * Domain adapters can specialize the four generic axes without changing the
 * slot registry contract. The default keeps unknown owner data honest while
 * still exposing the framework-owned session, store, and locale seats.
 */
export interface DshSlotProps<
  Owner = unknown,
  Value = unknown,
  State = unknown,
  Actions extends object = Record<string, unknown>,
> {
  owner?: Owner
  selected?: Value
  value?: Value
  matched?: Value
  store?: StoreInstance<State, Actions>
  actions?: Actions
  sessionId?: string
  locale?: (key: string) => string
  t?: (key: string) => string
  resources?: ClientResourceService
}

export interface DshOwnerMap {
  'conversation.chat.node': {
    node: UINode
    nodeId: string
    kind: UINode['kind']
  }
  'tool.call.toolview': {
    callId: string
    toolName: string
    block: Extract<UINode, { kind: 'tool' }>
  }
  'sidebar.right.pane.tab': {
    tabId: 'document' | 'guide'
    title: string
    active: boolean
  }
  'sidebar.right.pane.tab.title': {
    tabId: 'document' | 'guide'
    title: string
    active: boolean
  }
  'sidebar.right.tab.document': {
    id: string
    title?: string
    kind: 'text' | 'markdown' | 'html' | 'image' | 'pdf' | 'code'
    content?: string
    resourceUrl?: string
    laneId?: string
    artifact?: ClientDocumentArtifact
  }
  'sidebar.right.tab.guide': {
    tabId: 'guide'
  }
  'sidebar.right.tab.guide.entry': {
    tabId: 'guide'
    entryId: string
  }
  'sidebar.right.tab.menu.item': {
    activeTab: 'document' | 'guide'
  }
  'conversation.session.header.actions': {
    sessionId: string
  }
  'conversation.session.header.corner': {
    sessionId: string
  }
  'conversation.session.header.lineage': {
    sessionId: string
  }
  'conversation.session.header.utilities': {
    sessionId: string
  }
  'conversation.composer.dock': {
    composerId: string
  }
  'conversation.hero.agentPreset': {
    surface: 'conversation.hero'
  }
  'conversation.hero.brand.mark': {
    surface: 'conversation.hero'
  }
  'conversation.hero.workspace': {
    surface: 'conversation.hero'
  }
  'conversation.hero.workspace.directoryFlow': {
    surface: 'conversation.hero.workspace'
  }
}

export type DshSlotPropsFor<N extends DshSlotName> = N extends keyof DshOwnerMap
  ? DshSlotProps<DshOwnerMap[N]>
  : DshSlotProps

export type SlotMap = LegacySlotMap & { [N in DshSlotName]: DshSlotPropsFor<N> }
export type SlotName = WebClientModuleSlotName | DshSlotName
export type SlotProps<N extends SlotName> = SlotMap[N]
type LegacyWebClientModuleSlotName = Exclude<WebClientModuleSlotName, DshSlotName>
export type SlotDeclaration = CoreSlotSpec
export type SlotSpec = CoreSlotSpec
export type { ChainSelection, LiveSlotNode, SlotChildren, SlotKind, SlotLabel, SlotScope }

/** Pure selector contract used by chain slots. */
export type ChainSelect<Owner = unknown, Value = unknown> = (owner: Owner) => Value | null

/** Renderer options specific to a chain outlet. */
export interface ChainRenderOpts {
  /** Keep the fallback mounted but hidden while a chain winner is active. */
  overlay?: boolean
  /** Owner passed to each chain selector. */
  owner?: unknown
  /** Optional fallback supplied by a renderer. */
  fallback?: unknown
}

/** Existing built-in outlets are additive lists; extensions can declare any of the four kinds. */
export const SLOT_TABLE: Readonly<Record<LegacyWebClientModuleSlotName, SlotDeclaration>> = {
  'tool.card.inline': { kind: 'list', scope: 'root' },
  'client.card': { kind: 'list', scope: 'root' },
  'workbench.panel': { kind: 'list', scope: 'session-maybe' },
}

/** A React-facing view of the React-free kernel entry. */
export type SlotEntry<N extends SlotName = SlotName> = StoredEntry & {
  readonly name: N
  readonly component: ComponentType<SlotProps<N>>
}

export function asSlotEntry<N extends SlotName = SlotName>(entry: StoredEntry): SlotEntry<N> {
  return entry as SlotEntry<N>
}

/** Type-only anchor for consumers that need to inspect a registry's core. */
export type SlotKernel = SlotCore
