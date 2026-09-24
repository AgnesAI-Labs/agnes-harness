import { isProxy } from 'node:util/types'
import type { ArtifactRef } from '@agnes/core'

const DEFAULT_MAX_RECENT_ARTIFACTS = 100
const SHA256 = /^[0-9a-f]{64}$/u

export type RecentArtifactMetadataSnapshot = Readonly<{
  sessionKey: string
  purpose: 'recent-ui-and-dedup-metadata'
  /** This cache is neither a reachability root nor evidence that bytes may be deleted. */
  gcDeletionAuthority: false
  artifacts: readonly Readonly<ArtifactRef>[]
}>

export type RecentArtifactMetadataIndex = Readonly<{
  /** Records one artifact as most recent, deduplicated by its content-addressed SHA-256 identity. */
  record(sessionKey: string, ref: ArtifactRef | unknown): RecentArtifactMetadataSnapshot
  snapshot(sessionKey: string): RecentArtifactMetadataSnapshot
  /** Compaction evicts the advisory window so old pixels cannot serve as a post-compaction dedup hint. */
  resetForCompaction(sessionKey: string): void
  /** Session teardown removes only that session's metadata. Artifact bytes and GC roots are untouched. */
  resetSession(sessionKey: string): void
}>

function checkedSessionKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  )
    throw new TypeError('invalid artifact metadata session identity')
  return value
}

function snapshotRef(value: unknown): Readonly<ArtifactRef> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value))
    throw new TypeError('invalid artifact metadata identity')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('invalid artifact metadata identity')
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
  const keys = Reflect.ownKeys(descriptors)
  if (
    keys.length !== 3 ||
    keys.some((key) => typeof key !== 'string' || !['mime', 'sha256', 'size'].includes(key)) ||
    keys.some((key) => {
      const descriptor = typeof key === 'string' ? descriptors[key] : undefined
      return !descriptor?.enumerable || !('value' in descriptor)
    })
  )
    throw new TypeError('invalid artifact metadata identity')
  const sha256 = descriptors.sha256?.value
  const size = descriptors.size?.value
  const mime = descriptors.mime?.value
  if (
    typeof sha256 !== 'string' ||
    !SHA256.test(sha256) ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof mime !== 'string' ||
    mime.length < 1 ||
    mime.length > 256 ||
    [...mime].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  )
    throw new TypeError('invalid artifact metadata identity')
  return Object.freeze({ sha256, size, mime })
}

function frozenSnapshot(
  sessionKey: string,
  artifacts: readonly Readonly<ArtifactRef>[],
): RecentArtifactMetadataSnapshot {
  return Object.freeze({
    sessionKey,
    purpose: 'recent-ui-and-dedup-metadata' as const,
    gcDeletionAuthority: false as const,
    artifacts: Object.freeze([...artifacts]),
  })
}

/**
 * Creates an in-memory, per-session recent metadata window. It intentionally has no artifact byte,
 * reachability, retention, or deletion operation; global GC remains owned by reachability scans.
 */
export function createRecentArtifactMetadataIndex(
  maxRecentArtifacts = DEFAULT_MAX_RECENT_ARTIFACTS,
): RecentArtifactMetadataIndex {
  if (
    !Number.isSafeInteger(maxRecentArtifacts) ||
    maxRecentArtifacts < 1 ||
    maxRecentArtifacts > DEFAULT_MAX_RECENT_ARTIFACTS
  )
    throw new TypeError('recent artifact metadata limit must be an integer from 1 to 100')
  const sessions = new Map<string, Readonly<ArtifactRef>[]>()
  return Object.freeze({
    record(sessionValue, refValue) {
      const sessionKey = checkedSessionKey(sessionValue)
      const ref = snapshotRef(refValue)
      const prior = sessions.get(sessionKey) ?? []
      const sameDigest = prior.find((entry) => entry.sha256 === ref.sha256)
      if (sameDigest && sameDigest.size !== ref.size)
        throw new Error('artifact metadata content identity collision')
      const next = [ref, ...prior.filter((entry) => entry.sha256 !== ref.sha256)].slice(0, maxRecentArtifacts)
      sessions.set(sessionKey, next)
      return frozenSnapshot(sessionKey, next)
    },
    snapshot(sessionValue) {
      const sessionKey = checkedSessionKey(sessionValue)
      return frozenSnapshot(sessionKey, sessions.get(sessionKey) ?? [])
    },
    resetForCompaction(sessionValue) {
      sessions.delete(checkedSessionKey(sessionValue))
    },
    resetSession(sessionValue) {
      sessions.delete(checkedSessionKey(sessionValue))
    },
  })
}
