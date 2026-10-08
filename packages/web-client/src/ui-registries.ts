import type { ComponentType } from 'react'
import type { ClientResourceService, SessionService } from './services.js'

/** Presentation extensions have no effect on backend configuration or authorization. */
export type UiExtensionContext = {
  t(key: string, vars?: Readonly<Record<string, string | number>>): string
  session?: SessionService | undefined
  resources?: ClientResourceService | undefined
  data?: unknown
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
  id: string
  order: number
  matches(input: ConversationCardInput): boolean
  component: ComponentType<{ card: ConversationCardInput; context: UiExtensionContext }>
}>
/** A session dock panel. `right` is the side dock and `bottom` is the lower dock. */
export type WorkbenchPanel = Readonly<{
  id: string
  order: number
  edge: 'right' | 'bottom'
  titleKey: string
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
    if (!/^[a-z][a-z0-9.-]*$/.test(entry.id) || !Number.isFinite(entry.order))
      throw new Error('Invalid UI extension registration')
    this.validate?.(entry)
    if (this.#entries.has(entry.id)) throw new Error(`UI extension already registered: ${entry.id}`)
    const stored = Object.freeze({ ...entry }) as Entry
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
    for (const listener of this.#listeners) listener()
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
