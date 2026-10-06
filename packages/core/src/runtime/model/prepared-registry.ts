import type { RequestBody } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import type { ModelCapture, WireIdentity } from './wire-request.js'
import type { ResolvedTools } from './wire-tools.js'

/** What stays in this process for one prepared call: never serialised, never written to a ledger. */
export type PreparedEntry = Readonly<{
  runId: string
  sessionId: string
  ownerBinding: W.BindingRef
  inputDigest: W.Digest
  header: W.PreparedModelHeader
  prepared: W.PreparedModelRequest
  capture: ModelCapture
  wire: WireIdentity
  request: RequestBody
  /** The tools the request was built from; kept so a later rebuild of the wire and the digest check reuse them. */
  resolvedTools: ResolvedTools | null
}>

/**
 * The port the model provider writes and the source reader reads. Both sides must share one instance in
 * one process; a miss is a normal outcome (eviction or restart) and is handled by the caller.
 */
export interface PreparedRegistry {
  put(handleId: string, entry: PreparedEntry): void
  get(handleId: string): PreparedEntry | undefined
  clear(): void
}

export type PreparedRegistryOptions = Readonly<{ maxEntries?: number; ttlMs?: number; now?: () => number }>

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const member of Object.values(value)) deepFreeze(member)
  }
  return value
}

/**
 * A bounded map with a time limit. Single use is not enforced here; the one send is fenced durably by the
 * model source store. Writing the same key with the same content only refreshes it.
 */
export function createPreparedRegistry(options: PreparedRegistryOptions = {}): PreparedRegistry {
  const maxEntries = options.maxEntries ?? 256
  const ttlMs = options.ttlMs ?? 30 * 60_000
  const now = options.now ?? Date.now
  const entries = new Map<string, { entry: PreparedEntry; digest: string; expiresAt: number }>()
  const live = (key: string) => {
    const slot = entries.get(key)
    if (slot && slot.expiresAt <= now()) entries.delete(key)
    return entries.get(key)
  }
  return {
    put(handleId, entry) {
      const digest = canonicalJsonDigest(entry as never)
      const present = live(handleId)
      if (present && present.digest !== digest) throw new Error('Prepared handle already holds other content')
      entries.delete(handleId)
      entries.set(handleId, {
        entry: present?.entry ?? deepFreeze(structuredClone(entry)),
        digest,
        expiresAt: now() + ttlMs,
      })
      for (const [key, slot] of entries) {
        if (entries.size <= maxEntries && slot.expiresAt > now()) break
        entries.delete(key)
      }
    },
    get: (handleId) => live(handleId)?.entry,
    clear: () => entries.clear(),
  }
}
