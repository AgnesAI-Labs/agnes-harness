import type { ResourceRef } from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'

type Entry = {
  ref: ResourceRef
  owners: Map<string, Set<string>>
  retired: boolean
  disposed: boolean
  disposing?: Promise<void>
  dispose: () => void | Promise<void>
}

/** Process-local ownership only. These tokens are never durable RetentionRef/pin proofs. */
export class ResourceRetention {
  private readonly entries = new Map<string, Entry>()
  private readonly tokens = new Map<string, { key: string; owner: string; active: boolean }>()
  private closed = false

  track(ref: ResourceRef, dispose: () => void | Promise<void>): void {
    if (this.closed || !validateRuntime('ResourceRef', ref).ok) throw new Error('retention_invalid')
    const key = canonicalJsonDigest(ref)
    if (this.entries.has(key)) throw new Error('retention_duplicate_resource')
    this.entries.set(key, {
      ref: structuredClone(ref),
      owners: new Map(),
      retired: false,
      disposed: false,
      dispose,
    })
  }

  retain(ref: ResourceRef, owner: string, token: string): boolean {
    const key = canonicalJsonDigest(ref)
    const prior = this.tokens.get(token)
    if (prior) {
      if (prior.key !== key || prior.owner !== owner) throw new Error('retention_identity_conflict')
      if (!prior.active) throw new Error('retention_released')
      return false
    }
    const entry = this.entries.get(key)
    if (this.closed || !entry || entry.retired || !owner || !token) throw new Error('retention_unavailable')
    const held = entry.owners.get(owner) ?? new Set<string>()
    held.add(token)
    entry.owners.set(owner, held)
    this.tokens.set(token, { key, owner, active: true })
    return true
  }

  async release(ref: ResourceRef, owner: string, token: string): Promise<boolean> {
    const key = canonicalJsonDigest(ref)
    const prior = this.tokens.get(token)
    if (!prior) throw new Error('retention_unknown_token')
    if (prior.key !== key || prior.owner !== owner) throw new Error('retention_identity_conflict')
    const entry = this.entries.get(key)
    if (!entry) throw new Error('retention_unavailable')
    const changed = prior.active
    prior.active = false
    const held = entry.owners.get(owner)
    held?.delete(token)
    if (held?.size === 0) entry.owners.delete(owner)
    await this.collect(entry)
    return changed
  }

  count(ref: ResourceRef): number {
    const entry = this.entries.get(canonicalJsonDigest(ref))
    return entry ? [...entry.owners.values()].reduce((sum, held) => sum + held.size, 0) : 0
  }

  async retire(ref: ResourceRef): Promise<void> {
    const entry = this.entries.get(canonicalJsonDigest(ref))
    if (!entry) throw new Error('retention_unavailable')
    entry.retired = true
    await this.collect(entry)
  }

  async ownerExit(owner: string): Promise<void> {
    const cleanup: Promise<boolean>[] = []
    for (const [token, held] of this.tokens) {
      if (held.owner !== owner) continue
      const entry = this.entries.get(held.key)
      if (entry && held.active) cleanup.push(this.release(entry.ref, owner, token))
      else if (entry) cleanup.push(this.collect(entry).then(() => false))
    }
    await this.finish(cleanup)
  }

  async close(): Promise<void> {
    this.closed = true
    const cleanup: Promise<void>[] = []
    for (const entry of this.entries.values()) {
      entry.retired = true
      cleanup.push(this.collect(entry))
    }
    await this.finish(cleanup)
  }

  private async finish(cleanup: Promise<unknown>[]): Promise<void> {
    const results = await Promise.allSettled(cleanup)
    const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'retention_dispose_failed')
  }

  private async collect(entry: Entry): Promise<void> {
    if (!entry.retired || entry.owners.size !== 0 || entry.disposed) return
    if (!entry.disposing) {
      entry.disposing = Promise.resolve()
        .then(entry.dispose)
        .then(() => {
          entry.disposed = true
        })
    }
    try {
      await entry.disposing
    } finally {
      delete entry.disposing
    }
  }
}
