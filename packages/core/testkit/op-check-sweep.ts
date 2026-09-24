// Opens every session of a recorded scenario at every point the store could be left in: after each
// commit and after each child is created, every key the scenario has touched is opened by a fresh
// writer from a copy of the store, once replaying the whole ledger and once resuming from a fold
// cache. Any open that fails is a legal state the open-time checks refuse.
import { defaultIds } from '../src/ids.js'
import type { IntegrityState } from '../src/log/integrity.js'
import type { SessionLogImpl } from '../src/log/session-log.js'
import type { CommitTx, FoldCacheRecord, StorageAdapter } from '../src/log/storage.js'
import { encodeFoldCache } from '../src/project/cache.js'
import { openTracked } from '../src/reduce/tracker.js'
import { recordTransitions } from './record-transitions.js'

export type SweepStore = {
  /** A fresh, empty store for the scenario to write to. */
  make(): StorageAdapter
  /**
   * A separate store holding exactly what `live` has committed so far, with no writer holding any
   * session. Called synchronously as a write resolves, so nothing else can land in between.
   */
  snapshot(live: StorageAdapter): StorageAdapter
  /** Gives back a store `snapshot` or `make` returned. */
  dispose(storage: StorageAdapter): Promise<void>
}

export type SweepResult = {
  /** Commits and child creations after which the store was opened. */
  points: number
  /** Opens made, with and without a fold cache. */
  opens: number
  /** Opens that resumed from a fold cache rather than replaying from the first row. */
  cachedOpens: number
  /** Opens of a child ledger. */
  childOpens: number
  failures: string[]
}

const openCheck = (storage: StorageAdapter, key: string) =>
  openTracked({
    storage,
    key,
    writerRunId: 'check',
    ttlMs: 60_000,
    ids: defaultIds(() => 0),
    clock: () => 0,
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
  })

/** The store with its fold cache hidden, so an open replays every row. */
const withoutFoldCache = (storage: StorageAdapter): StorageAdapter =>
  new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'foldCache') return undefined
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

/** The store serving `record` as the fold cache of `key`. */
const withFoldCache = (storage: StorageAdapter, key: string, record: FoldCacheRecord): StorageAdapter =>
  new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'foldCache')
        return async (asked: string) => (asked === key ? structuredClone(record) : target.foldCache?.(asked))
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

const integrityOf = (log: SessionLogImpl): IntegrityState =>
  (log as unknown as { integrityState: IntegrityState }).integrityState

export async function sweepOpenPoints(name: string, store: SweepStore): Promise<SweepResult> {
  const live = store.make()
  const keys: string[] = []
  const result: SweepResult = { points: 0, opens: 0, cachedOpens: 0, childOpens: 0, failures: [] }

  const openAll = async (snapshot: StorageAdapter, known: string[], after: string): Promise<void> => {
    result.points++
    for (const key of known) {
      const where = `${name} ${after} (point ${result.points}), key ${key}`
      try {
        const replayed = await openCheck(withoutFoldCache(snapshot), key)
        const record = encodeFoldCache(key, replayed.tracker.state, integrityOf(replayed.log))
        const isChild = replayed.log.parent !== undefined
        await replayed.log.close()
        result.opens++
        if (isChild) result.childOpens++
        const cached = await openCheck(withFoldCache(snapshot, key, record), key)
        const resumed = cached.log.restoredFold !== undefined
        await cached.log.close()
        result.opens++
        if (isChild) result.childOpens++
        if (resumed) result.cachedOpens++
        else result.failures.push(`${where}: the fold cache was not used`)
      } catch (error) {
        result.failures.push(`${where}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // The scenario gets the adapter's own promise back, so its writes resolve exactly when they would
  // without the sweep; holding them back reorders concurrent writes. The copy is taken by the first
  // callback on that promise, before the scenario can write again, and opened later, one at a time.
  let queue: Promise<void> = Promise.resolve()
  const sweepAfter = <T>(write: Promise<T>, key: string, after: string): Promise<T> => {
    write.then(
      () => {
        if (!keys.includes(key)) keys.push(key)
        const at = [...keys]
        let snapshot: StorageAdapter
        try {
          snapshot = store.snapshot(live)
        } catch (error) {
          result.failures.push(`${name} ${after}: no copy of the store (${String(error)})`)
          return
        }
        queue = queue.then(async () => {
          try {
            await openAll(snapshot, at, after)
          } finally {
            await store.dispose(snapshot)
          }
        })
      },
      () => undefined,
    )
    return write
  }

  const tapped = new Proxy(live, {
    get(target, property, receiver) {
      if (property === 'commit')
        return (key: string, tx: CommitTx) => sweepAfter(target.commit(key, tx), key, 'after a commit')
      if (property === 'createChild')
        return (parentKey: string, boundarySeq: number, childKey: string) =>
          sweepAfter(
            target.createChild(parentKey, boundarySeq, childKey),
            childKey,
            'after a child was created',
          )
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  try {
    await recordTransitions(name, tapped)
    await queue
  } finally {
    await store.dispose(live)
  }
  return result
}
