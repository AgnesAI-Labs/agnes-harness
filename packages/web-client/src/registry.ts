/** Cordis service wrapper around the React-free @agnes/web-slots kernel. */
import { type Context, Service } from '@agnes/cordis'
import {
  type ChainSelection,
  type RegisterOptions as CoreRegisterOptions,
  SlotCore,
  type SlotSpec,
  type StoredEntry,
} from '@agnes/web-slots'
import type { ComponentType } from 'react'
import { asSlotEntry, SLOT_TABLE, type SlotEntry, type SlotName, type SlotProps } from './slots.js'

export type RegisterOptions = Omit<CoreRegisterOptions, 'name'> & {
  /** Legacy list ordering remains available to existing Agnes modules. */
  order?: number
}

type ObjectRegister<N extends SlotName = SlotName> = Omit<CoreRegisterOptions, 'name'> & { name: N }

export class SlotRegistry extends Service {
  readonly core: SlotCore
  private legacyId = 0
  private currentSessionId: string | undefined
  private readonly sessionListeners = new Set<() => void>()
  private boundSessionSource:
    | { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void }
    | undefined
  private boundSessionStop: (() => void) | undefined
  private boundSessionRefs = 0
  private localeSource:
    | {
        t(key: string): string
        bind(namespace: string): (key: string) => string
        subscribe?: (listener: () => void) => () => void
      }
    | undefined
  private localeStop: (() => void) | undefined
  private localeVersion = 0
  private readonly localeListeners = new Set<() => void>()

  constructor(ctx: Context) {
    super(ctx, 'slots')
    this.core = new SlotCore()
    for (const [name, spec] of Object.entries(SLOT_TABLE) as [string, SlotSpec][]) {
      this.core.declare(name, spec, '(built-in)')
    }
  }

  /** Declare a child or host-owned outlet. Repeated declarations fail closed. */
  declare(name: string, spec: SlotSpec, declaredBy?: string, parent?: string): void {
    this.core.declare(name, spec, declaredBy, parent)
  }

  register<N extends SlotName>(
    name: N,
    component: ComponentType<SlotProps<N>>,
    options?: RegisterOptions,
  ): () => void
  register<N extends SlotName>(options: ObjectRegister<N>, component: ComponentType<SlotProps<N>>): () => void
  register(options: ObjectRegister, component: unknown): () => void
  register(
    nameOrOptions: SlotName | ObjectRegister,
    component: unknown,
    options?: RegisterOptions,
  ): () => void {
    const registration: CoreRegisterOptions =
      typeof nameOrOptions === 'string'
        ? {
            name: nameOrOptions,
            ...options,
            ...(this.core.spec(nameOrOptions)?.kind === 'list' && options?.id === undefined
              ? { id: `legacy-${++this.legacyId}` }
              : {}),
          }
        : nameOrOptions
    if (this.core.spec(registration.name)?.kind === 'list' && registration.id === undefined) {
      registration.id = `legacy-${++this.legacyId}`
    }
    if (!this.core.spec(registration.name) && typeof nameOrOptions === 'string') {
      throw new Error(`unknown slot: ${registration.name}`)
    }
    return this.core.register(registration, component)
  }

  entries(name: SlotName | string): readonly SlotEntry[] {
    return this.core.entries(name).map(asSlotEntry)
  }

  entriesOfSlot(name: SlotName | string): readonly SlotEntry[] {
    return this.core.entriesOfSlot(name).map(asSlotEntry)
  }

  /** Actual runtime registrations for a package, for diagnostics and policy checks. */
  entriesByOwner(owner: string): readonly SlotEntry[] {
    return this.core.entriesByOwner(owner).map(asSlotEntry)
  }

  spec(name: string): SlotSpec | undefined {
    return this.core.spec(name)
  }
  declarationEpoch(name: string): number {
    return this.core.declarationEpoch(name)
  }
  getVersion(name: string): number {
    return this.core.getVersion(name)
  }
  isLive(entry: SlotEntry): boolean {
    return this.core.isLive(entry)
  }
  remove(key: string): void {
    this.core.remove(key)
  }
  removeOwner(owner: string): void {
    this.core.removeOwner(owner)
  }
  acquireStore(entry: SlotEntry, scopeKey = 'root') {
    return this.core.acquireStore(entry, scopeKey)
  }
  pruneStoreScope(scopeKey: string): void {
    this.core.pruneStoreScope(scopeKey)
  }

  /** Current scope identity used by session-scoped slot stores and outlets. */
  get sessionId(): string | undefined {
    return this.currentSessionId
  }

  /**
   * Reattach all session-aware consumers to a new scope.  The old store seats
   * are destroyed before observers are notified, so a render cannot observe a
   * half-old/half-new session.  Reattaching to the same id is a no-op.
   */
  setSession(sessionId: string | undefined): void {
    if (sessionId === this.currentSessionId) return
    const previous = this.currentSessionId
    this.currentSessionId = sessionId
    // `empty` is a real session-maybe store seat. It must be retired when the
    // first session arrives just like a previous concrete session seat.
    this.core.pruneSessionScope(previous ?? 'empty')
    for (const listener of [...this.sessionListeners]) listener()
  }

  /** Bind a SessionService-like source without making the kernel depend on it. */
  bindSession(source: {
    getSnapshot(): string | undefined
    subscribe(listener: () => void): () => void
  }): () => void {
    if (this.boundSessionSource === source) {
      this.boundSessionRefs += 1
      return () => this.releaseSessionBinding(source)
    }
    this.boundSessionStop?.()
    this.boundSessionSource = source
    this.boundSessionRefs = 1
    const update = () => this.setSession(source.getSnapshot())
    update()
    this.boundSessionStop = source.subscribe(update)
    return () => this.releaseSessionBinding(source)
  }

  private releaseSessionBinding(source: { getSnapshot(): string | undefined }): void {
    if (this.boundSessionSource !== source) return
    this.boundSessionRefs -= 1
    if (this.boundSessionRefs > 0) return
    this.boundSessionStop?.()
    this.boundSessionStop = undefined
    this.boundSessionSource = undefined
    this.setSession(undefined)
  }

  subscribeSession(listener: () => void): () => void {
    this.sessionListeners.add(listener)
    return () => this.sessionListeners.delete(listener)
  }

  /** Bind the host locale service for outlets mounted below this registry. */
  setLocaleSource(
    source:
      | {
          t(key: string): string
          bind(namespace: string): (key: string) => string
          subscribe?: (listener: () => void) => () => void
        }
      | undefined,
  ): void {
    if (source === this.localeSource) return
    this.localeStop?.()
    this.localeStop = undefined
    this.localeSource = source
    this.localeStop = source?.subscribe?.(() => {
      this.localeVersion += 1
      for (const listener of [...this.localeListeners]) listener()
    })
  }

  getLocaleSource(): typeof this.localeSource {
    return this.localeSource
  }

  getLocaleVersion(): number {
    return this.localeVersion
  }

  subscribeLocale(listener: () => void): () => void {
    this.localeListeners.add(listener)
    return () => this.localeListeners.delete(listener)
  }

  scopeAvailable(name: string, sessionId = this.currentSessionId): boolean {
    const scope = this.core.spec(name)?.scope
    return scope !== 'session' || sessionId !== undefined
  }

  selectChain(
    name: string,
    owner: unknown,
    onError?: (entry: StoredEntry, error: unknown) => void,
  ): ChainSelection | undefined {
    return this.core.selectChain(name, owner, onError)
  }

  subscribe(listener: () => void): () => void
  subscribe(name: string, listener: () => void): () => void
  subscribe(nameOrListener: string | (() => void), maybeListener?: () => void): () => void {
    // Keep the original web-client service contract synchronous for existing
    // consumers. React outlets use subscribeBatched below, matching the
    // kernel's microtask render channel.
    const name = typeof nameOrListener === 'string' ? nameOrListener : undefined
    const listener = typeof nameOrListener === 'function' ? nameOrListener : maybeListener
    if (!listener) throw new TypeError('SlotRegistry.subscribe requires a listener')
    return this.core.onMutate((changed) => {
      if (name === undefined || changed === name) listener()
    })
  }

  subscribeBatched(name: string, listener: () => void): () => void {
    return this.core.subscribe(name, listener)
  }

  subscribeDeclaration(name: string, listener: () => void): () => void {
    return this.core.subscribeDeclaration(name, listener)
  }

  inject(name: string, factory: () => unknown): () => void {
    return this.core.inject(name, factory)
  }

  reportEntryError(name: string, entry: SlotEntry, error: unknown, info?: { abdicate: boolean }): void {
    this.core.reportEntryError(name, entry, error, info)
  }

  onEntryError(listener: Parameters<SlotCore['onEntryError']>[0]): () => void {
    return this.core.onEntryError(listener)
  }

  snapshot(root?: string) {
    return this.core.snapshot(root)
  }
}

export type { StoredEntry }
