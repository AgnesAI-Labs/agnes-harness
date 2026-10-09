/**
 * The browser slot kernel.
 *
 * This package deliberately has no React or Cordis runtime dependency.  It owns
 * the declaration ledger, lifecycle rules and change propagation; a renderer
 * can consume the read-only entry projections and keep its own error boundary.
 */

export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'
export type SlotScope = 'root' | 'session-maybe' | 'session'

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
