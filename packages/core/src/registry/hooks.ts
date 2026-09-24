import { extEventType, type HookEvent, type HookHandler } from '@agnes/extension-api'
import { isHookEvent } from '@agnes/protocol'
import { CoreError, type Disposer } from '../types.js'
import { OwnedRegistryTable } from './owner-batch.js'
import type { ToolSource } from './tools.js'

// Callback types are erased only in storage; registration and invocation retain the event key.
type Registration = Readonly<{ event: HookEvent; handler: unknown; meta: Readonly<ToolSource> }>
export type HookSnapshot = { entries(event: HookEvent): readonly Registration[] }

/** Shared registration ownership. Scheduling and quotas remain in each session's HookEngine. */
export class HookRegistry {
  private readonly entries = new OwnedRegistryTable<Registration>()

  on<E extends HookEvent>(event: E, handler: NoInfer<HookHandler<E>>, meta: ToolSource): Disposer {
    if (
      !isHookEvent(event) ||
      typeof handler !== 'function' ||
      !['builtin', 'trusted'].includes(meta.trust) ||
      (meta.hookRank !== undefined && (!Number.isSafeInteger(meta.hookRank) || meta.hookRank < 0))
    ) {
      throw new CoreError('E_ENVELOPE', 'invalid hook registration')
    }
    extEventType(meta.source, 'hook')
    const entry = Object.freeze({ event, handler, meta: Object.freeze({ ...meta }) })
    return this.entries.add(meta.source, event, entry)
  }

  prepareOwnerReplacement(owner: string, candidate: HookRegistry) {
    return this.entries.prepare(owner, candidate.entries)
  }

  registrations(source: string): string[] {
    return this.entries
      .values()
      .filter((entry) => entry.meta.source === source)
      .map((entry) => `hook:${entry.event}`)
  }

  snapshot(source?: string): HookSnapshot {
    if (source !== undefined) extEventType(source, 'hook')
    const captured = new Map<HookEvent, Registration[]>()
    for (const entry of this.entries.values()) {
      if (source !== undefined && entry.meta.source !== source) continue
      const list = captured.get(entry.event)
      if (list) list.push(entry)
      else captured.set(entry.event, [entry])
    }
    // Stable sort: the built-in layer (has hookRank) dispatches first, in ascending rank order; the
    // third-party layer (no hookRank) follows, in registration order. Array#sort is a stable sort, so
    // ties among the undefined-rank entries keep the insertion order they already had.
    const frozen = new Map<HookEvent, readonly Registration[]>()
    for (const [event, list] of captured) {
      list.sort(
        (a, b) =>
          (a.meta.hookRank ?? Number.POSITIVE_INFINITY) - (b.meta.hookRank ?? Number.POSITIVE_INFINITY),
      )
      frozen.set(event, Object.freeze(list))
    }
    const empty = Object.freeze([])
    return Object.freeze({ entries: (event: HookEvent) => frozen.get(event) ?? empty })
  }
}
