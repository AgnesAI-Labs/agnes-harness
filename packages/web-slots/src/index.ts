/**
 * The browser slot kernel.
 *
 * This package deliberately has no React or Cordis runtime dependency.  It owns
 * the declaration ledger, lifecycle rules and change propagation; a renderer
 * can consume the read-only entry projections and keep its own error boundary.
 */

export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'
export type SlotScope = 'root' | 'session-maybe' | 'session'

/** The daemon-owned row namespace for browser-only package contributions. */
export const WEB_ROW_PREFIX = 'web:'

export function isWebRowId(id: string): boolean {
  return id.startsWith(WEB_ROW_PREFIX) && id.length > WEB_ROW_PREFIX.length
}

export function webRowId(packageId: string): string {
  if (!packageId || packageId.includes(':')) {
    throw new Error(`invalid package id for web row: ${packageId}`)
  }
  return `${WEB_ROW_PREFIX}${packageId}`
}

export function packageIdFromWebRowId(id: string): string | undefined {
  return isWebRowId(id) ? id.slice(WEB_ROW_PREFIX.length) : undefined
}

export interface SlotSpec {
  kind: SlotKind
  scope: SlotScope
  /** Optional data shared with every child registration's component. */
  inject?: object
}

/** The result of running a chain selector for one outlet owner. */
export interface ChainSelection {
  readonly entry: StoredEntry
  /** The selector's value.  It is deliberately kept separate from component props. */
  readonly value: unknown
}

export type SlotChildren = Readonly<Record<string, SlotSpec>>
export type SlotLabel = string | (() => string)

export function resolveSlotLabel(label: SlotLabel | undefined): string | undefined {
  return typeof label === 'function' ? label() : label
}

export interface StoreInstance<State = unknown, Actions extends object = Record<string, unknown>> {
  getSnapshot(): State
  subscribe(listener: () => void): () => void
  readonly actions: Actions
  destroy?(): void
}

export interface StoreHandle<State = unknown, Actions extends object = Record<string, unknown>> {
  create(scopeKey?: string): StoreInstance<State, Actions>
}

export interface DefineStoreSpec<State, Actions extends object = Record<string, unknown>> {
  initial: State
  actions?: (set: (next: State | ((previous: State) => State)) => void, get: () => State) => Actions
  create?: (scopeKey?: string) => StoreInstance<State, Actions>
}

/** A small dependency-free store seat. Hosts may provide a richer handle. */
export function defineStore<State, Actions extends object = Record<string, never>>(
  spec: DefineStoreSpec<State, Actions>,
): StoreHandle<State, Actions> {
  if (spec.create) return { create: spec.create }
  return {
    create() {
      let state = spec.initial
      const listeners = new Set<() => void>()
      const set = (next: State | ((previous: State) => State)) => {
        state = typeof next === 'function' ? (next as (previous: State) => State)(state) : next
        for (const listener of [...listeners]) listener()
      }
      const get = () => state
      const actions = spec.actions?.(set, get) ?? ({} as Actions)
      return {
        getSnapshot: get,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        actions,
        destroy() {
          listeners.clear()
        },
      }
    },
  }
}

export type StoreDecl<State = unknown, Actions extends object = Record<string, unknown>> =
  | StoreHandle<State, Actions>
  | ((scopeKey?: string) => StoreInstance<State, Actions>)

export interface RegisterOptions {
  name: string
  key?: string
  id?: string
  order?: number
  label?: SlotLabel
  priority?: number
  select?: (owner: unknown) => unknown | null
  children?: SlotChildren
  store?: StoreDecl
  locale?: string
  registrant?: string
  owner?: string
  /** Business face factory; the renderer binds its result to the component. */
  inject?: (...args: never[]) => Record<string, unknown>
}

export interface StoredEntry {
  readonly key: string
  readonly name: string
  readonly component: unknown
  /** Legacy flat fields retained for @agnes/web-client consumers. */
  readonly id?: string
  readonly order?: number
  readonly label?: SlotLabel
  readonly priority: number
  readonly options: Readonly<{
    key?: string
    id?: string
    order?: number
    label?: SlotLabel
    priority?: number
  }>
  readonly select?: (owner: unknown) => unknown | null
  readonly inject?: (...args: never[]) => Record<string, unknown>
  readonly children?: SlotChildren
  readonly store?: StoreDecl
  readonly locale?: string
  readonly registrant?: string
  readonly owner?: string
}

export interface LiveSlotOccupant {
  registrant?: string
  key?: string
  id?: string
  order?: number
  priority: number
  active: boolean
}

export interface LiveSlotNode {
  name: string
  kind: SlotKind
  scope: SlotScope
  declaredBy?: string
  occupants: LiveSlotOccupant[]
  children: LiveSlotNode[]
}

type EntryErrorListener = (
  key: string,
  entry: StoredEntry,
  error: unknown,
  info: { abdicated: boolean },
) => void

interface SlotRecord {
  spec: SlotSpec | undefined
  declaredBy: string | undefined
  parent: string | undefined
  declarationEpoch: number
  entries: readonly StoredEntry[]
  version: number
  listeners: Set<() => void>
  declarationListeners: Set<() => void>
}

const NO_ENTRIES: readonly StoredEntry[] = Object.freeze([])

/**
 * Pure slot ledger.  `SlotRegistry` in `@agnes/web-client` supplies the Cordis
 * service wrapper, while this class remains reusable by non-React renderers.
 */
export class SlotCore {
  private sequence = 0
  private readonly records = new Map<string, SlotRecord>()
  private readonly mutateListeners = new Set<(name: string) => void>()
  private readonly entryErrorListeners = new Set<EntryErrorListener>()
  private readonly storeScopes = new Map<object, { scope: SlotScope; count: number }>()
  private readonly storeInstances = new Map<StoredEntry, Map<string, StoreInstance>>()
  private readonly abdicated = new WeakSet<StoredEntry>()
  private readonly dirty = new Set<SlotRecord>()
  private flushScheduled = false

  declare(name: string, spec: SlotSpec, declaredBy?: string, parent?: string): void {
    const record = this.record(name)
    if (record.spec) {
      throw new Error(`slot "${name}" is already declared (by ${record.declaredBy ?? 'an unknown entry'})`)
    }
    record.spec = { ...spec }
    record.declaredBy = declaredBy
    record.parent = parent
    record.declarationEpoch += 1
    this.markDirty(name, record)
    this.notifyDeclaration(record)
  }

  register(options: RegisterOptions, component: unknown): () => void {
    const record = this.records.get(options.name)
    if (!record?.spec) {
      throw new Error(
        `slot "${options.name}" is not declared (a parent entry's children table must declare it)`,
      )
    }
    const spec = record.spec
    const priority = options.priority ?? 0
    this.validateKind(options, spec, record.entries, priority)
    if (options.children) {
      for (const childName of Object.keys(options.children)) {
        const child = this.records.get(childName)
        if (child?.spec) {
          throw new Error(
            `slot "${childName}" is already declared (by ${child.declaredBy ?? 'an unknown entry'})`,
          )
        }
      }
    }
    this.pinStore(options.store, spec.scope)

    const sequence = ++this.sequence
    const entry: StoredEntry = {
      key: `${options.name}#${sequence}`,
      name: options.name,
      component,
      ...(options.id === undefined ? {} : { id: options.id }),
      order: options.order ?? sequence,
      ...(options.label === undefined ? {} : { label: options.label }),
      priority,
      options: {
        ...(options.key === undefined ? {} : { key: options.key }),
        ...(options.id === undefined ? {} : { id: options.id }),
        ...(options.order === undefined ? {} : { order: options.order }),
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.priority === undefined ? {} : { priority: options.priority }),
      },
      ...(options.select === undefined ? {} : { select: options.select }),
      ...(options.inject === undefined ? {} : { inject: options.inject }),
      ...(options.children === undefined ? {} : { children: options.children }),
      ...(options.store === undefined ? {} : { store: options.store }),
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      ...(options.registrant === undefined ? {} : { registrant: options.registrant }),
      ...(options.owner === undefined ? {} : { owner: options.owner }),
    }
    const next = [...record.entries, entry]
    next.sort((left, right) => {
      const byPriority = (left.options.priority ?? 0) - (right.options.priority ?? 0)
      if (byPriority !== 0) return byPriority
      if (spec.kind === 'list') return (left.options.order ?? 0) - (right.options.order ?? 0)
      return 0
    })
    record.entries = next
    this.markDirty(options.name, record)

    if (options.children) {
      const children = Object.entries(options.children)
      for (const [childName, childSpec] of children) {
        const child = this.record(childName)
        child.spec = { ...childSpec }
        child.declaredBy = `an entry in "${options.name}"${options.registrant ? ` (${options.registrant})` : ''}`
        child.parent = options.name
        child.declarationEpoch += 1
      }
      // A sibling declaration table is one atomic declaration publication.
      for (const [childName] of children) {
        const child = this.record(childName)
        this.markDirty(childName, child)
        this.notifyDeclaration(child)
      }
    }

    let live = true
    return () => {
      if (!live) return
      live = false
      if (!record.entries.includes(entry)) return
      record.entries = record.entries.filter((candidate) => candidate !== entry)
      this.markDirty(options.name, record)
      this.releaseStore(options.store)
      this.releaseEntryStores(entry)
      this.collapseChildren(entry)
    }
  }

  entries(name: string): readonly StoredEntry[] {
    return this.records.get(name)?.entries ?? NO_ENTRIES
  }

  /** Returns the currently renderable entry per cell (or every chain entry). */
  entriesOfSlot(name: string): readonly StoredEntry[] {
    const record = this.records.get(name)
    if (!record?.spec) return NO_ENTRIES
    if (record.spec.kind === 'chain') {
      return record.entries.filter((entry) => !this.abdicated.has(entry))
    }
    const selected: StoredEntry[] = []
    const cells = new Set<string | undefined>()
    for (const entry of record.entries) {
      if (this.abdicated.has(entry)) continue
      const cell =
        record.spec.kind === 'keyed'
          ? entry.options.key
          : record.spec.kind === 'list'
            ? entry.options.id
            : undefined
      if (cells.has(cell)) continue
      cells.add(cell)
      selected.push(entry)
    }
    return selected
  }

  /**
   * Runtime truth for diagnostics: all currently live registrations owned by
   * one package, including the slot name they actually reached.  This is not a
   * manifest projection, so a declared-but-never-registered slot is absent.
   */
  entriesByOwner(owner: string): readonly StoredEntry[] {
    const entries: StoredEntry[] = []
    for (const record of this.records.values()) {
      for (const entry of record.entries) if (entry.owner === owner) entries.push(entry)
    }
    return entries
  }

  /**
   * Elect one chain entry.  Selectors are tried in the already stable priority
   * order; nullish results decline, while selector failures are isolated and
   * treated as a decline.  The failed selector is intentionally not abdicated:
   * abdication is a render-error decision made by the outlet.
   */
  selectChain(
    name: string,
    owner: unknown,
    onError?: (entry: StoredEntry, error: unknown) => void,
  ): ChainSelection | undefined {
    const record = this.records.get(name)
    if (record?.spec?.kind !== 'chain') return undefined
    for (const entry of record.entries) {
      if (this.abdicated.has(entry) || !entry.select) continue
      try {
        const value = entry.select(owner)
        if (value !== null && value !== undefined) return { entry, value }
      } catch (error) {
        onError?.(entry, error)
        console.warn(`[web-slots] chain selector declined ${name}:`, error)
      }
    }
    return undefined
  }

  isAbdicated(entry: StoredEntry): boolean {
    return this.abdicated.has(entry)
  }

  spec(name: string): SlotSpec | undefined {
    return this.records.get(name)?.spec
  }

  declarationEpoch(name: string): number {
    return this.records.get(name)?.declarationEpoch ?? 0
  }

  getVersion(name: string): number {
    return this.records.get(name)?.version ?? 0
  }

  isLive(entry: StoredEntry): boolean {
    for (const record of this.records.values()) {
      if (record.entries.includes(entry)) return true
    }
    return false
  }

  /** Remove every contribution owned by a package during roster withdrawal. */
  removeOwner(owner: string): void {
    for (const [name, record] of this.records) {
      const doomed = record.entries.filter((entry) => entry.owner === owner)
      if (doomed.length === 0) continue
      record.entries = record.entries.filter((entry) => entry.owner !== owner)
      this.markDirty(name, record)
      for (const entry of doomed) {
        this.releaseStore(entry.store)
        this.releaseEntryStores(entry)
        this.collapseChildren(entry)
      }
    }
  }

  /** Remove one registration by its opaque key; retained for legacy callers. */
  remove(key: string): void {
    for (const [name, record] of this.records) {
      const entry = record.entries.find((candidate) => candidate.key === key)
      if (!entry) continue
      record.entries = record.entries.filter((candidate) => candidate !== entry)
      this.markDirty(name, record)
      this.releaseStore(entry.store)
      this.releaseEntryStores(entry)
      this.collapseChildren(entry)
      return
    }
  }

  subscribe(name: string, listener: () => void): () => void {
    const record = this.record(name)
    record.listeners.add(listener)
    return () => record.listeners.delete(listener)
  }

  subscribeDeclaration(name: string, listener: () => void): () => void {
    const record = this.record(name)
    record.declarationListeners.add(listener)
    return () => record.declarationListeners.delete(listener)
  }

  /** Register a declaration-aware contribution before the slot exists. */
  inject(name: string, factory: () => unknown): () => void {
    let cleanup: (() => void) | undefined
    let active = true
    const run = () => {
      if (!active || !this.spec(name)) return
      try {
        cleanup = normalizeDisposer(factory())
      } catch (error) {
        this.reportInjectionError(name, error)
      }
    }
    const stop = this.subscribeDeclaration(name, () => {
      if (!this.spec(name)) {
        cleanup?.()
        cleanup = undefined
      } else {
        cleanup?.()
        run()
      }
    })
    if (this.spec(name)) run()
    return () => {
      active = false
      stop()
      cleanup?.()
      cleanup = undefined
    }
  }

  reportEntryError(
    name: string,
    entry: StoredEntry,
    error: unknown,
    info: { abdicate: boolean } = { abdicate: true },
  ): void {
    if (info.abdicate) {
      if (this.abdicated.has(entry)) return
      this.abdicated.add(entry)
      const record = this.records.get(name)
      if (record) this.markDirty(name, record)
    }
    for (const listener of [...this.entryErrorListeners]) {
      listener(name, entry, error, { abdicated: info.abdicate })
    }
  }

  onEntryError(listener: EntryErrorListener): () => void {
    this.entryErrorListeners.add(listener)
    return () => this.entryErrorListeners.delete(listener)
  }

  onMutate(listener: (name: string) => void): () => void {
    this.mutateListeners.add(listener)
    return () => this.mutateListeners.delete(listener)
  }

  /** Lazily materialize a registered store seat for one scope identity. */
  acquireStore(entry: StoredEntry, scopeKey = 'root'): StoreInstance | undefined {
    const declaration = entry.store
    if (!declaration || !this.isLive(entry)) return undefined
    let instances = this.storeInstances.get(entry)
    if (!instances) {
      instances = new Map()
      this.storeInstances.set(entry, instances)
    }
    const current = instances.get(scopeKey)
    if (current) return current
    const instance = typeof declaration === 'function' ? declaration(scopeKey) : declaration.create(scopeKey)
    instances.set(scopeKey, instance)
    return instance
  }

  /** Drop all per-session store seats for an unloaded scope. */
  pruneStoreScope(scopeKey: string): void {
    for (const [entry, instances] of this.storeInstances) {
      const instance = instances.get(scopeKey)
      if (!instance) continue
      instance.destroy?.()
      instances.delete(scopeKey)
      if (instances.size === 0 || !this.isLive(entry)) this.storeInstances.delete(entry)
    }
  }

  /** Drop only session-aware seats; root-scoped stores survive a session switch. */
  pruneSessionScope(scopeKey: string): void {
    for (const [entry, instances] of this.storeInstances) {
      if (this.records.get(entry.name)?.spec?.scope === 'root') continue
      const instance = instances.get(scopeKey)
      if (!instance) continue
      instance.destroy?.()
      instances.delete(scopeKey)
      if (instances.size === 0 || !this.isLive(entry)) this.storeInstances.delete(entry)
    }
  }

  snapshot(root?: string): LiveSlotNode[] {
    const build = (name: string, seen: Set<string>): LiveSlotNode | undefined => {
      const record = this.records.get(name)
      if (!record?.spec || seen.has(name)) return undefined
      const branch = new Set(seen)
      branch.add(name)
      const active = new Set(this.entriesOfSlot(name))
      const children = [...this.records]
        .filter(([, child]) => child.spec && child.parent === name)
        .flatMap(([childName]) => {
          const node = build(childName, branch)
          return node ? [node] : []
        })
      return {
        name,
        kind: record.spec.kind,
        scope: record.spec.scope,
        ...(record.declaredBy === undefined ? {} : { declaredBy: record.declaredBy }),
        occupants: record.entries.map((entry) => ({
          ...(entry.registrant === undefined ? {} : { registrant: entry.registrant }),
          ...(entry.options.key === undefined ? {} : { key: entry.options.key }),
          ...(entry.options.id === undefined ? {} : { id: entry.options.id }),
          ...(entry.options.order === undefined ? {} : { order: entry.options.order }),
          priority: entry.options.priority ?? 0,
          active: active.has(entry),
        })),
        children,
      }
    }
    if (root !== undefined) {
      const node = build(root, new Set())
      return node ? [node] : []
    }
    return [...this.records]
      .filter(
        ([, record]) =>
          record.spec && (record.parent === undefined || !this.records.get(record.parent)?.spec),
      )
      .flatMap(([name]) => {
        const node = build(name, new Set())
        return node ? [node] : []
      })
  }

  private validateKind(
    options: RegisterOptions,
    spec: SlotSpec,
    entries: readonly StoredEntry[],
    priority: number,
  ): void {
    if (spec.kind === 'keyed' && options.key === undefined) {
      throw new Error(`keyed slot "${options.name}" requires options.key`)
    }
    if (spec.kind === 'list' && options.id === undefined) {
      throw new Error(`list slot "${options.name}" requires options.id`)
    }
    if (spec.kind === 'chain' && options.select === undefined) {
      throw new Error(`chain slot "${options.name}" requires options.select`)
    }
    if (spec.kind === 'chain') return
    const same = entries.find((entry) => {
      if ((entry.options.priority ?? 0) !== priority) return false
      if (spec.kind === 'single') return true
      return spec.kind === 'keyed' ? entry.options.key === options.key : entry.options.id === options.id
    })
    if (!same) return
    const cell =
      spec.kind === 'single'
        ? ''
        : ` for ${spec.kind === 'keyed' ? `key "${options.key}"` : `id "${options.id}"`}`
    throw new Error(`${spec.kind} slot "${options.name}" already has an entry${cell} at priority ${priority}`)
  }

  private collapseChildren(entry: StoredEntry): void {
    for (const childName of Object.keys(entry.children ?? {})) {
      const child = this.records.get(childName)
      if (!child?.spec) continue
      const doomed = child.entries
      child.spec = undefined
      child.declaredBy = undefined
      child.parent = undefined
      child.entries = NO_ENTRIES
      child.declarationEpoch += 1
      this.markDirty(childName, child)
      this.notifyDeclaration(child)
      for (const dead of doomed) {
        this.releaseStore(dead.store)
        this.releaseEntryStores(dead)
        this.collapseChildren(dead)
      }
    }
  }

  private pinStore(store: StoreDecl | undefined, scope: SlotScope): void {
    if (store === undefined) return
    const key = store as object
    const current = this.storeScopes.get(key)
    if (current && current.scope !== scope) {
      throw new Error(
        `store handle mounted under scope "${current.scope}" cannot mount under scope "${scope}" (one handle, one scope)`,
      )
    }
    if (current) current.count += 1
    else this.storeScopes.set(key, { scope, count: 1 })
  }

  private releaseStore(store: StoreDecl | undefined): void {
    if (store === undefined) return
    const key = store as object
    const current = this.storeScopes.get(key)
    if (!current) return
    current.count -= 1
    if (current.count <= 0) this.storeScopes.delete(key)
  }

  private releaseEntryStores(entry: StoredEntry): void {
    const instances = this.storeInstances.get(entry)
    if (!instances) return
    for (const instance of instances.values()) instance.destroy?.()
    this.storeInstances.delete(entry)
  }

  private reportInjectionError(name: string, error: unknown): void {
    // Injection is a contribution boundary: a bad optional contributor must
    // not prevent the declaration ledger from serving other outlets.
    console.warn(`[web-slots] injection failed for ${name}:`, error)
  }

  private record(name: string): SlotRecord {
    let record = this.records.get(name)
    if (!record) {
      record = {
        spec: undefined,
        declaredBy: undefined,
        parent: undefined,
        declarationEpoch: 0,
        entries: NO_ENTRIES,
        version: 0,
        listeners: new Set(),
        declarationListeners: new Set(),
      }
      this.records.set(name, record)
    }
    return record
  }

  private markDirty(name: string, record: SlotRecord): void {
    record.version += 1
    for (const listener of [...this.mutateListeners]) listener(name)
    this.dirty.add(record)
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => this.flush())
  }

  private notifyDeclaration(record: SlotRecord): void {
    for (const listener of [...record.declarationListeners]) listener()
  }

  private flush(): void {
    this.flushScheduled = false
    const dirty = [...this.dirty]
    this.dirty.clear()
    for (const record of dirty) {
      for (const listener of [...record.listeners]) listener()
    }
  }
}

function normalizeDisposer(value: unknown): (() => void) | undefined {
  if (typeof value === 'function') return value as () => void
  if (value && typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function') {
    const disposers = [...(value as Iterable<unknown>)].filter(
      (item): item is () => void => typeof item === 'function',
    )
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }
  return undefined
}
