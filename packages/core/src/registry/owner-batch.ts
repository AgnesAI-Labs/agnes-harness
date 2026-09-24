import { extEventType } from '@agnes/extension-api'
import { CoreError } from '../types.js'

export interface PreparedOwnerReplacement {
  readonly owner: string
  readonly previous: readonly unknown[]
  commit(): readonly unknown[]
  /** Reverse a committed replacement before its deployment decision is published. */
  restore(): void
  /** Make a committed replacement irreversible and retire the detached previous identities. */
  finalize(): void
  discard(): void
}

type RecordEntry<T> = { owner: string; key: string; value: T; table: OwnedRegistryTable<T> }

/** Internal storage shared by Core registries and the Host Service registry. */
export class OwnedRegistryTable<T> {
  private readonly records = new Set<RecordEntry<T>>()
  private readonly index = new Map<string, RecordEntry<T>>()
  private readonly owners = new Set<string>()
  private readonly names = new Set<string>()
  private readonly sealed = new Set<RecordEntry<T>>()

  constructor(
    private readonly unique = false,
    private readonly removed: (value: T) => void = () => undefined,
  ) {}

  values(): T[] {
    return [...this.records].map((record) => record.value)
  }
  get(key: string): T | undefined {
    return this.unique
      ? this.index.get(key)?.value
      : [...this.records].find((record) => record.key === key)?.value
  }
  get size(): number {
    return this.records.size
  }

  add(owner: string, key: string, value: T): () => void {
    if (this.owners.has(owner) || (this.unique && (this.names.has(key) || this.get(key) !== undefined)))
      throw new CoreError('E_REGISTRY_DUPLICATE', 'registration conflicts with live or prepared owner')
    const record = { owner, key, value, table: this }
    this.records.add(record)
    if (this.unique) this.index.set(key, record)
    return () => record.table.release(record)
  }

  private release(record: RecordEntry<T>): void {
    if (this.sealed.has(record))
      throw new CoreError('E_REGISTRY_DUPLICATE', 'candidate registration is prepared')
    if (this.records.delete(record)) {
      if (this.index.get(record.key) === record) this.index.delete(record.key)
      this.removed(record.value)
    }
  }

  purgeOwner(owner: string): void {
    for (const record of [...this.records]) if (record.owner === owner) this.release(record)
  }

  /** Candidate tables contain production-validated registrations, never raw author objects. */
  prepare(owner: string, candidate: OwnedRegistryTable<T>): PreparedOwnerReplacement {
    extEventType(owner, 'batch')
    if (candidate === this || this.owners.has(owner) || candidate.owners.has(owner))
      throw new CoreError('E_REGISTRY_DUPLICATE', 'owner already prepared')
    const next = [...candidate.records]
    if (next.some((record) => record.owner !== owner))
      throw new CoreError('E_ENVELOPE', 'candidate contains another owner')
    const keys = next.map((record) => record.key)
    if (
      this.unique &&
      keys.some(
        (key) =>
          this.names.has(key) ||
          [...this.records].some((record) => record.key === key && record.owner !== owner),
      )
    )
      throw new CoreError('E_REGISTRY_DUPLICATE', 'candidate name conflicts')
    const previousRecords = [...this.records].filter((record) => record.owner === owner)
    const previous = Object.freeze(previousRecords.map((record) => record.value))
    const reservedKeys = [...new Set([...keys, ...previousRecords.map((record) => record.key)])]
    // A committed-but-unpublished replacement must be reversible without reconstructing author
    // registrations. Keep the exact old record identities in a detached table: an old disposer
    // that runs in this window removes only that identity, and restore never resurrects it.
    const detached = new OwnedRegistryTable<T>(this.unique, this.removed)
    this.owners.add(owner)
    candidate.owners.add(owner)
    for (const key of reservedKeys) if (this.unique) this.names.add(key)
    for (const record of next) candidate.sealed.add(record)
    let state: 'prepared' | 'committed' | 'restored' | 'finalized' | 'discarded' = 'prepared'
    let locked = true
    const unlock = () => {
      if (!locked) return
      locked = false
      this.owners.delete(owner)
      candidate.owners.delete(owner)
      for (const key of reservedKeys) if (this.unique) this.names.delete(key)
      for (const record of next) candidate.sealed.delete(record)
    }
    return Object.freeze({
      owner,
      previous,
      commit: () => {
        if (state === 'discarded') throw new CoreError('E_ENVELOPE', 'replacement discarded')
        if (state === 'restored') throw new CoreError('E_ENVELOPE', 'replacement restored')
        if (state === 'finalized') return previous
        if (state === 'committed') return previous
        // Only internal storage operations: no validation, author callback, I/O or await.
        for (const record of previousRecords) {
          if (!this.records.delete(record)) continue
          if (this.index.get(record.key) === record) this.index.delete(record.key)
          record.table = detached
          detached.records.add(record)
          if (this.unique) detached.index.set(record.key, record)
        }
        for (const record of next) {
          candidate.records.delete(record)
          if (candidate.index.get(record.key) === record) candidate.index.delete(record.key)
          record.table = this
          this.records.add(record)
          if (this.unique) this.index.set(record.key, record)
        }
        state = 'committed'
        // The candidate is now live and its identity-bound disposer must remain usable. Owner/name
        // reservations stay held until restore/finalize so a third mutation cannot interleave.
        for (const record of next) candidate.sealed.delete(record)
        return previous
      },
      restore: () => {
        if (state === 'restored') return
        if (state !== 'committed') throw new CoreError('E_ENVELOPE', 'replacement is not restorable')
        // Move surviving candidate identities back to their private table without invoking removal
        // callbacks. Candidate cleanup remains the candidate bag's responsibility after restore.
        for (const record of next) {
          if (!this.records.delete(record)) continue
          if (this.index.get(record.key) === record) this.index.delete(record.key)
          record.table = candidate
          candidate.records.add(record)
          if (this.unique) candidate.index.set(record.key, record)
        }
        // An old disposer may have removed an identity from detached while commit was pending. Only
        // surviving records return, so rollback cannot resurrect an explicitly released entry.
        for (const record of [...detached.records]) {
          detached.records.delete(record)
          if (detached.index.get(record.key) === record) detached.index.delete(record.key)
          record.table = this
          this.records.add(record)
          if (this.unique) this.index.set(record.key, record)
        }
        state = 'restored'
        unlock()
      },
      finalize: () => {
        if (state === 'finalized') return
        if (state !== 'committed') throw new CoreError('E_ENVELOPE', 'replacement is not finalizable')
        detached.purgeOwner(owner)
        state = 'finalized'
        unlock()
      },
      discard: () => {
        if (state !== 'prepared') return
        state = 'discarded'
        unlock()
      },
    })
  }
}

/** Compose only trusted registry participants; failure releases every earlier reservation. */
export function prepareOwnerReplacement(
  owner: string,
  participants: readonly (() => PreparedOwnerReplacement)[],
): PreparedOwnerReplacement {
  const prepared: PreparedOwnerReplacement[] = []
  try {
    for (const participant of participants) {
      const part = participant()
      prepared.push(part)
      if (part.owner !== owner) throw new CoreError('E_ENVELOPE', 'batch owner mismatch')
    }
  } catch (error) {
    for (const part of prepared.reverse()) part.discard()
    throw error
  }
  const previous = Object.freeze(prepared.flatMap((part) => part.previous))
  let state: 'prepared' | 'committed' | 'restored' | 'finalized' | 'discarded' = 'prepared'
  return Object.freeze({
    owner,
    previous,
    commit: () => {
      if (state === 'discarded') throw new CoreError('E_ENVELOPE', 'replacement discarded')
      if (state === 'committed') return previous
      for (const part of prepared) part.commit()
      state = 'committed'
      return previous
    },
    restore: () => {
      if (state === 'restored') return
      if (state !== 'committed') throw new CoreError('E_ENVELOPE', 'replacement is not restorable')
      for (const part of [...prepared].reverse()) part.restore()
      state = 'restored'
    },
    finalize: () => {
      if (state === 'finalized') return
      if (state !== 'committed') throw new CoreError('E_ENVELOPE', 'replacement is not finalizable')
      for (const part of prepared) part.finalize()
      state = 'finalized'
    },
    discard: () => {
      if (state !== 'prepared') return
      for (const part of [...prepared].reverse()) part.discard()
      state = 'discarded'
    },
  })
}
