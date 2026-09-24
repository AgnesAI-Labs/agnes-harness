import { OwnedRegistryTable } from '../registry/owner-batch.js'
import { canonicalJson } from '../request/hash.js'
import { CoreError, type Disposer, type Event, type Seq } from '../types.js'

export type ProjectionDef<S> = {
  key: string
  stateVersion: number
  stateSchema?: (state: unknown) => boolean
  init(): S
  apply(state: S, event: Event): S
  view?(state: S): unknown
}
export type ProjectionCacheLine = { key: string; seq: Seq; ver: number; state: unknown }
type ProjectionFailure = { key: string; seq: Seq; message: string }
type Unit = { state: unknown; view?: unknown; stateVersion: number } | { error: string }
export type ProjectionSnapshot = { asOfSeq: Seq; units: Record<string, Unit> }
type Entry = {
  key: string
  owner?: string
  def: ProjectionDef<unknown>
  cache: Map<string, ProjectionCacheLine>
  quarantine: Map<string, ProjectionFailure>
}

export class ProjectionRegistry {
  private readonly entries = new OwnedRegistryTable<Entry>(true, (entry) => {
    if (entry.owner !== undefined) this.clearEntry(entry)
  })
  private readonly caches = new Map<string, Map<string, ProjectionCacheLine>>()
  private readonly failed: ProjectionFailure[] = []

  register<S>(definition: ProjectionDef<S>, meta?: { owner: string }): Disposer {
    if (this.entries.get(definition.key))
      throw new CoreError('E_REGISTRY_DUPLICATE', `projection ${definition.key}`)
    // Owner registrations replay after every revoke/reload, even if the version number is reused.
    const cache = meta
      ? new Map<string, ProjectionCacheLine>()
      : (this.caches.get(definition.key) ?? new Map<string, ProjectionCacheLine>())
    const entry: Entry = {
      ...(meta ? { owner: meta.owner } : {}),
      key: definition.key,
      def: definition as ProjectionDef<unknown>,
      cache,
      quarantine: new Map(),
    }
    const dispose = this.entries.add(meta?.owner ?? '', definition.key, entry)
    if (meta) this.caches.delete(entry.key)
    else this.caches.set(entry.key, cache)
    return dispose
  }

  prepareOwnerReplacement(owner: string, candidate: ProjectionRegistry) {
    const keys = candidate.entries.values().map((entry) => entry.key)
    const previousLegacyCaches = new Map(
      keys.flatMap((key) => {
        const cache = this.caches.get(key)
        return cache ? ([[key, cache]] as const) : []
      }),
    )
    const prepared = this.entries.prepare(owner, candidate.entries)
    const previousEntries = prepared.previous as readonly Entry[]
    const previousKeys = new Set(previousEntries.map((entry) => entry.key))
    const previousFailures = this.failed.filter((failure) => previousKeys.has(failure.key))
    let committed = false,
      restored = false
    return Object.freeze({
      ...prepared,
      commit: () => {
        const previous = prepared.commit()
        if (!committed) {
          for (const key of keys) this.caches.delete(key)
          // Keep old per-entry cache/quarantine alive for recovery, but stop reporting failures
          // from the detached generation while the candidate is the live projection.
          for (let index = this.failed.length - 1; index >= 0; index--)
            if (previousKeys.has(this.failed[index]?.key ?? '')) this.failed.splice(index, 1)
        }
        committed = true
        return previous
      },
      restore: () => {
        if (restored) return
        prepared.restore()
        // Candidate failures belong to its now-private entries and must not remain globally visible.
        for (let index = this.failed.length - 1; index >= 0; index--)
          if (keys.includes(this.failed[index]?.key ?? '')) this.failed.splice(index, 1)
        const restoredEntries = new Set(this.entries.values())
        const restoredKeys = new Set(
          previousEntries.filter((entry) => restoredEntries.has(entry)).map((entry) => entry.key),
        )
        this.failed.push(...previousFailures.filter((failure) => restoredKeys.has(failure.key)))
        for (const key of keys) {
          const cache = previousLegacyCaches.get(key)
          if (cache) this.caches.set(key, cache)
        }
        restored = true
      },
      finalize: () => prepared.finalize(),
    })
  }

  private clearEntry(entry: Entry): void {
    if (this.caches.get(entry.key) === entry.cache) this.caches.delete(entry.key)
    entry.cache.clear()
    entry.quarantine.clear()
    for (let i = this.failed.length - 1; i >= 0; i--)
      if (this.failed[i]?.key === entry.key) this.failed.splice(i, 1)
  }

  registrations(owner: string): string[] {
    return [...this.entries.values()]
      .filter((e) => e.owner === owner)
      .map((e) => `projection:${e.key}`)
      .sort()
  }

  purgeOwner(owner: string): void {
    this.entries.purgeOwner(owner)
  }

  snapshotOne(sessionKey: string, key: string, events: Iterable<Event>, asOfSeq?: Seq): Unit {
    const entry = this.entries.get(key)
    if (!entry) return { error: 'unavailable' }
    return this.snapshotEntries(sessionKey, events, [entry], asOfSeq).units[key] ?? { error: 'unavailable' }
  }

  failures(): ProjectionFailure[] {
    return this.failed.map((failure) => ({ ...failure }))
  }

  cacheLine(sessionKey: string, key: string): ProjectionCacheLine | undefined {
    return (this.entries.get(key)?.cache ?? this.caches.get(key))?.get(sessionKey)
  }

  snapshot(sessionKey: string, events: Iterable<Event>, asOfSeq?: Seq): ProjectionSnapshot {
    return this.snapshotEntries(sessionKey, events, this.entries.values(), asOfSeq)
  }

  private snapshotEntries(
    sessionKey: string,
    events: Iterable<Event>,
    entries: Iterable<Entry>,
    asOfSeq?: Seq,
  ): ProjectionSnapshot {
    const rows = [...events]
      .filter((event) => asOfSeq === undefined || event.seq <= asOfSeq)
      .sort((a, b) => a.seq - b.seq)
    const upto = rows.at(-1)?.seq ?? 0
    const units = Object.create(null) as ProjectionSnapshot['units']
    for (const { key, def, cache, quarantine, owner } of entries) {
      const failure = quarantine.get(sessionKey)
      if (failure && failure.seq <= upto) {
        units[key] = { error: owner === undefined ? failure.message : 'unavailable' }
        continue
      }
      let line = cache.get(sessionKey)
      let state = line?.state
      let seq = line?.seq ?? 0
      try {
        if (
          line &&
          (line.ver !== def.stateVersion ||
            line.seq > upto ||
            (def.stateSchema !== undefined && !def.stateSchema(line.state)))
        ) {
          cache.delete(sessionKey)
          line = undefined
          state = undefined
          seq = 0
        }
        if (!line) state = def.init()
        for (const event of rows) {
          if (event.seq <= seq) continue
          seq = event.seq
          const next = def.apply(state, event)
          if (!Object.is(next, state) && canonicalJson(next) === canonicalJson(state))
            throw new Error(
              `apply returned a new reference with unchanged content at seq ${seq} (Object.is violated)`,
            )
          state = next
        }
        cache.set(sessionKey, { key, seq, ver: def.stateVersion, state })
        units[key] = {
          state,
          ...(def.view ? { view: def.view(state) } : {}),
          stateVersion: def.stateVersion,
        }
      } catch (error) {
        let message = 'unavailable'
        if (owner === undefined) {
          try {
            message = error instanceof Error ? error.message : String(error)
          } catch {
            /* hostile thrown value */
          }
        }
        const record = { key, seq, message }
        this.failed.push(record)
        quarantine.set(sessionKey, record)
        cache.delete(sessionKey)
        units[key] = { error: owner === undefined ? record.message : 'unavailable' }
      }
    }
    return { asOfSeq: upto, units }
  }
}
