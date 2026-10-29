import type { UINode, UITurn } from '@agnes/protocol'
import { notifyListeners } from '@agnes/sdk/browser'
import type { ComponentType } from 'react'
import type { ClientResourceService, SessionService } from './services.js'

/** Presentation extensions have no effect on backend configuration or authorization. */
export type UiExtensionContext = {
  t(key: string, vars?: Readonly<Record<string, string | number>>): string
  session?: SessionService | undefined
  resources?: ClientResourceService | undefined
  data?: unknown
  /** Presentation navigation only; payloads never confer backend authority. */
  selection?: unknown
  openPanel?(id: string, selection?: unknown): void
  /** Open an actual session tool record through the existing execution view. */
  openRecord?(sessionId: string, callSeq: number, resultSeq?: number): boolean
}
export type SettingsSection = Readonly<{
  /** False for sections whose own service supplies loading, refresh and error states. */
  runtimeCatalog?: boolean
  group: string
  id: string
  titleKey: string
  groupTitleKey: string
  icon: string
  order: number
  component: ComponentType<{ context: UiExtensionContext }>
  /** Built-in native pane bridge; plugin sections omit this field. */
  nativePane?: string
  navigationId?: string
}>
export type ConversationCardInput = Readonly<{ kind: string; data: unknown }>
export type ConversationCard = Readonly<{
  /** Optional projection of nodes folded into this contribution’s visible receipt. */
  hiddenNodeIds?(nodes: readonly UINode[], turns: readonly UITurn[]): readonly string[]
  id: string
  order: number
  matches(input: ConversationCardInput): boolean
  component: ComponentType<{ card: ConversationCardInput; context: UiExtensionContext }>
}>
/**
 * A number beside a dock tab's title, such as how many files changed. The dock reads it again
 * whenever the source notifies; undefined or zero shows nothing. Presentation only.
 */
export type WorkbenchPanelCount = Readonly<{
  subscribe(listener: () => void): () => void
  read(context: UiExtensionContext): number | undefined
}>
/** A session dock panel. `right` is the side dock and `bottom` is the lower dock. */
export type WorkbenchPanel = Readonly<{
  id: string
  order: number
  edge: 'right' | 'bottom'
  titleKey: string
  /** Presentation only. Omitted visibility keeps existing panels always visible. */
  visibility?: 'always' | 'contextual'
  icon?: string
  when?(context: UiExtensionContext): boolean
  /** Optional dynamic presentation title, e.g. a business surface title. */
  title?(context: UiExtensionContext): string
  count?: WorkbenchPanelCount
  /** Optional presentation-only destination for panel header actions. */
  component: ComponentType<{ context: UiExtensionContext; headerId?: string }>
}>

/** Registration returns an identity-bound disposer suitable for a client module's effect scope. */
export class UiExtensionRegistry<Entry extends { readonly id: string; readonly order: number }> {
  #entries = new Map<string, Entry>()
  #listeners = new Set<() => void>()
  #version = 0
  constructor(private readonly validate?: (entry: Entry) => void) {}
  register(entry: Entry): () => void {
    return this.registerPrepared(entry)
  }
  protected registerPrepared(entry: Entry, prepare?: (stored: Entry) => void): () => void {
    if (!/^[a-z][a-z0-9.-]*$/.test(entry.id) || !Number.isFinite(entry.order))
      throw new Error('Invalid UI extension registration')
    this.validate?.(entry)
    if (this.#entries.has(entry.id)) throw new Error(`UI extension already registered: ${entry.id}`)
    const stored = Object.freeze({ ...entry }) as Entry
    prepare?.(stored)
    this.#entries.set(entry.id, stored)
    this.#changed()
    return () => {
      if (this.#entries.get(entry.id) !== stored) return
      this.#entries.delete(entry.id)
      this.#changed()
    }
  }
  get(id: string): Entry | undefined {
    return this.#entries.get(id)
  }
  entries(): readonly Entry[] {
    return [...this.#entries.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, 'en'))
  }
  getSnapshot = (): number => this.#version
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  #changed() {
    this.#version += 1
    notifyListeners(this.#listeners, 'ui registry')
  }
}

/** Shared through the host's @agnes/web-client platform singleton, including installed modules. */
export const settingsSections = new UiExtensionRegistry<SettingsSection>()
export const conversationCards = new UiExtensionRegistry<ConversationCard>()
export const workbenchPanels = new UiExtensionRegistry<WorkbenchPanel>((entry) => {
  if (entry.edge !== 'right' && entry.edge !== 'bottom') throw new Error('Invalid workbench panel edge')
})

/** A file viewer contribution, independent of the panel supplying its review destination. */
export type FileViewerAction = Readonly<{
  id: string
  order: number
  component: ComponentType<{ context: UiExtensionContext; path: string; revision: string }>
}>
export const fileViewerActions = new UiExtensionRegistry<FileViewerAction>()

/** A numeric badge the host re-reads whenever the source notifies; zero shows no badge. */
export type HomeEntryBadge = Readonly<{
  subscribe(listener: () => void): () => void
  getSnapshot(): number
}>
/**
 * A home sidebar entry. Selecting it shows `component` as a full page in the main area, in place of
 * the conversation. `selection` on the component's context is the opaque value the opener passed.
 */
export type HomeEntry = Readonly<{
  id: string
  /** A shared icon name; an unknown name falls back to the generic page icon. */
  icon: string
  titleKey: string
  /** Optional quiet second label beside the title, e.g. an abbreviation. */
  subtitleKey?: string
  order: number
  /** Omitted placement preserves the secondary overflow behavior. */
  placement?: 'primary' | 'secondary'
  badge?: HomeEntryBadge
  component: ComponentType<{ context: UiExtensionContext }>
}>
export class HomeEntryRegistry extends UiExtensionRegistry<HomeEntry> {
  readonly #packages = new WeakMap<HomeEntry, string>()
  private check(entry: HomeEntry): void {
    if (entry.placement !== undefined && entry.placement !== 'primary' && entry.placement !== 'secondary')
      throw new Error('Invalid home placement')
    const entries = this.entries()
    if (
      entries.length >= 64 ||
      (entry.placement === 'primary' && entries.filter((item) => item.placement === 'primary').length >= 32)
    )
      throw new Error('Home entry registration limit exceeded')
  }
  override register(entry: HomeEntry): () => void {
    this.check(entry)
    return super.register(entry)
  }
  /** Host facade binds ownership before synchronous registry observers run. */
  registerOwned(packageId: string, entry: HomeEntry): () => void {
    this.check(entry)
    return this.registerPrepared(entry, (stored) => this.#packages.set(stored, packageId))
  }
  resolve(ref: string): HomeEntry | undefined {
    const separator = ref.indexOf('#')
    if (separator < 1) return undefined
    const entry = this.get(ref.slice(separator + 1))
    return entry && this.#packages.get(entry) === ref.slice(0, separator) ? entry : undefined
  }
}
export const homeEntries = new HomeEntryRegistry()

/** Primary entries never overflow; legacy secondary entries keep the three-entry threshold. */
export function homeEntryGroups(entries: readonly HomeEntry[]) {
  const sorted = [...entries].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, 'en'))
  const primary = sorted.filter((entry) => entry.placement === 'primary')
  const secondary = sorted.filter((entry) => entry.placement !== 'primary')
  return {
    inline: [...primary, ...(secondary.length <= 3 ? secondary : [])],
    more: secondary.length > 3 ? secondary : [],
  }
}

export type HomePageSelection = Readonly<{ id: string; selection?: unknown; pageRef?: string }>
/**
 * Which home entry page is requested. The page shows while an entry with that ID is registered; a
 * request whose entry is missing (not loaded yet, or its plugin was disabled) shows the conversation.
 */
export class HomeNavigation {
  #current: HomePageSelection | undefined
  #listeners = new Set<() => void>()
  open(id: string, selection?: unknown): void {
    this.#set(selection === undefined ? { id } : { id, selection })
  }
  /** A selected application page keeps its owner through unloads, failures and replacements. */
  openRef(pageRef: string, selection?: unknown): void {
    const separator = pageRef.indexOf('#')
    if (separator < 1) throw new Error('Invalid qualified home page')
    this.#set({
      id: pageRef.slice(separator + 1),
      pageRef,
      ...(selection === undefined ? {} : { selection }),
    })
  }
  close(): void {
    if (this.#current) this.#set(undefined)
  }
  getSnapshot = (): HomePageSelection | undefined => this.#current
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  #set(next: HomePageSelection | undefined) {
    this.#current = next
    notifyListeners(this.#listeners, 'home navigation')
  }
}
export const homeNavigation = new HomeNavigation()

/** Presentation-owned composer commands. Routing is a request; server admission remains authoritative. */
export type ComposerInputCommand = Readonly<{
  id: string
  order: number
  route(input: Readonly<{ text: string; sessionId?: string; busy: boolean }>): 'handled' | 'steer' | undefined
}>
export const composerCommands = new UiExtensionRegistry<ComposerInputCommand>()
