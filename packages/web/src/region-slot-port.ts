/**
 * The slot port that workbench regions mount through, and its SlotRegistry-backed implementation.
 *
 * Built-ins register as ordinary entries rather than outlet fallbacks: a plugin entry with a lower
 * priority shadows them, a failing plugin entry abdicates back to them, their child declarations
 * live and die with them, and their DOM carries the same slot-entry boundary as a plugin's.
 */
import {
  type ClientResourceService,
  type LocaleService,
  type RegisterOptions,
  type SessionService,
  type SlotEntry,
  type SlotName,
  SlotOutlet,
  type SlotOutletProps,
  type SlotRegistry,
  type SlotSpec,
  SlotsProvider,
} from '@agnes/web-client'
import { type ComponentType, createElement, type ReactElement } from 'react'

export interface RegionSlotContext {
  session?: SessionService | undefined
  locale?: LocaleService | undefined
  resources?: ClientResourceService | undefined
  /** Root-scoped regions must not remount when a session-scoped sibling changes session. */
  rootStable?: boolean
}

export interface RegionSlots {
  /** Whether `name` is already declared. */
  has(name: string): boolean
  /** Declare a host-owned slot; declaring a name twice fails closed. */
  declare(name: string, spec: SlotSpec, parent?: string): void
  /** Register a built-in occupant and return its remover. */
  register(entry: RegisterOptions & { name: string }, component: ComponentType<never>): () => void
  /** Current occupants of `name`, built-in and plugin. */
  entries(name: string): readonly SlotEntry[]
  /** Observe `name` on the same batched channel outlets render from. */
  subscribe(name: string, listener: () => void): () => void
  /** Render `props.name`, resolving its entries under `context`. */
  outlet<N extends SlotName>(props: SlotOutletProps<N>, context?: RegionSlotContext): ReactElement
}

/** Timeline nodes still project through the registry itself, so the transcript region needs it. */
export interface TranscriptRegionSlots extends RegionSlots {
  readonly registry: SlotRegistry
}

function rootStableRegistry(registry: SlotRegistry): SlotRegistry {
  const stable = Object.create(registry) as SlotRegistry
  Object.defineProperty(stable, 'sessionId', { configurable: true, get: () => undefined })
  Object.defineProperty(stable, 'subscribeSession', { configurable: true, value: () => () => undefined })
  return stable
}

export function registryRegionSlots(registry: SlotRegistry): TranscriptRegionSlots {
  return {
    registry,
    has: (name) => registry.spec(name) !== undefined,
    declare: (name, spec, parent) => registry.declare(name, spec, 'web-shell', parent),
    register: (entry, component) => registry.register(entry, component),
    entries: (name) => registry.entries(name),
    subscribe: (name, listener) => registry.subscribeBatched(name, listener),
    outlet: (props, { session, locale, resources, rootStable } = {}) =>
      createElement(
        SlotsProvider,
        {
          registry: rootStable ? rootStableRegistry(registry) : registry,
          ...(session ? { session } : {}),
          ...(locale ? { locale } : {}),
          ...(resources ? { resources } : {}),
        },
        createElement(SlotOutlet, props),
      ),
  }
}
