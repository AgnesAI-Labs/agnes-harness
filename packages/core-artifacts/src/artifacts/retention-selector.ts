import {
  ARTIFACT_ROOT_SOURCES,
  type ArtifactGcPlan,
  type ArtifactReachabilityInput,
  planArtifactGc,
  type StoredArtifactCandidate,
} from './reachability.js'

export type RetainedArtifactCandidate = StoredArtifactCandidate &
  Readonly<{ bytes: number; createdAtMs: number }>

export type ArtifactRetentionGcPlan = Readonly<{
  plan: ArtifactGcPlan
  /** Bounded deletion-only plan safe to hand to the physical executor. */
  executionPlan: ArtifactGcPlan
  totalBytes: number
  plannedDeleteBytes: number
  remainingBytes: number
  unresolvedPressureBytes: number
}>

function safeInteger(value: number, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`artifact GC ${label} is invalid`)
  return value
}

/**
 * Applies TTL first, then evicts the oldest globally unreachable bytes until the size cap is met.
 * If the store is still above the cap, a third pass evicts bytes that only the ledger or a
 * request-media manifest references, oldest last reference first; anything held by an export,
 * retention or rollback root is never chosen. Those referenced choices are reachable by design:
 * the execution plan carries no roots, so the deletion executor's own "unreachable" check does not
 * guard them, and the caller must prove the roots again under its deletion lock.
 * One plan stays within `maxDeletes` entries and, when given, `maxDeleteBytes` bytes; a single
 * candidate larger than the byte bound is still selected alone so collection always progresses.
 */
export function planRetainedArtifactGc(
  input: Readonly<{
    dataDir: string
    candidates: readonly RetainedArtifactCandidate[]
    roots: ArtifactReachabilityInput['roots']
    nowMs: number
    ttlMs: number
    maxExtendedTtlMs: number
    globalMaxBytes: number
    /** Protects a newly written artifact until its ledger root can be committed. */
    capacityGraceMs: number
    maxDeletes?: number
    maxDeleteBytes?: number
    /** Latest ledger reference time per digest; a digest without one falls back to its creation time. */
    lastReferencedAtMs: ReadonlyMap<string, number>
  }>,
): ArtifactRetentionGcPlan {
  const nowMs = safeInteger(input.nowMs, 0, 'clock')
  const ttlMs = safeInteger(input.ttlMs, 1, 'TTL')
  const maxExtendedTtlMs = safeInteger(input.maxExtendedTtlMs, ttlMs, 'maximum extended TTL')
  const globalMaxBytes = safeInteger(input.globalMaxBytes, 1, 'global byte cap')
  const capacityGraceMs = safeInteger(input.capacityGraceMs, 1, 'capacity grace')
  const maxDeletes = safeInteger(input.maxDeletes ?? 4096, 1, 'maximum deletion batch')
  const maxDeleteBytes =
    input.maxDeleteBytes === undefined
      ? Number.POSITIVE_INFINITY
      : safeInteger(input.maxDeleteBytes, 1, 'maximum deletion bytes')
  if (ttlMs > maxExtendedTtlMs) throw new Error('artifact GC TTL exceeds the maximum extended TTL')
  for (const value of input.lastReferencedAtMs.values()) safeInteger(value, 0, 'last reference time')
  let totalBytes = 0
  for (const candidate of input.candidates) {
    safeInteger(candidate.bytes, 0, 'candidate byte count')
    safeInteger(candidate.createdAtMs, 0, 'candidate creation time')
    if (candidate.createdAtMs > nowMs) throw new Error('artifact GC candidate creation time is in the future')
    totalBytes += candidate.bytes
    if (!Number.isSafeInteger(totalBytes)) throw new Error('artifact GC store byte count is unsafe')
  }
  const full = planArtifactGc({ dataDir: input.dataDir, candidates: input.candidates, roots: input.roots })
  if (full.blocked)
    return Object.freeze({
      plan: full,
      executionPlan: full,
      totalBytes,
      plannedDeleteBytes: 0,
      remainingBytes: totalBytes,
      unresolvedPressureBytes: Math.max(0, totalBytes - globalMaxBytes),
    })
  const reachable = new Set(full.kept.map((entry) => entry.sha256))
  const unreachable = input.candidates
    .filter((candidate) => !reachable.has(candidate.sha256))
    .sort((left, right) => left.createdAtMs - right.createdAtMs || left.sha256.localeCompare(right.sha256))
  const selected = new Set<string>()
  let plannedDeleteBytes = 0
  const batchFull = (candidate: RetainedArtifactCandidate) =>
    selected.size >= maxDeletes ||
    (selected.size > 0 && plannedDeleteBytes + candidate.bytes > maxDeleteBytes)
  for (const candidate of unreachable) {
    if (nowMs - candidate.createdAtMs < ttlMs) continue
    if (batchFull(candidate)) break
    selected.add(candidate.sha256)
    plannedDeleteBytes += candidate.bytes
  }
  for (const candidate of unreachable) {
    if (totalBytes - plannedDeleteBytes <= globalMaxBytes) break
    if (selected.has(candidate.sha256)) continue
    // CAS publication necessarily precedes the ledger event that makes the artifact reachable.
    // Never let capacity pressure delete that in-flight write during the bounded commit window.
    if (nowMs - candidate.createdAtMs < capacityGraceMs) continue
    if (batchFull(candidate)) break
    selected.add(candidate.sha256)
    plannedDeleteBytes += candidate.bytes
  }
  const referencedOnly = new Set(
    full.kept
      .filter(
        (entry) =>
          entry.reachableFrom.length > 0 &&
          entry.reachableFrom.every((source) => source === 'ledger' || source === 'request-media'),
      )
      .map((entry) => entry.sha256),
  )
  const lastUse = (candidate: RetainedArtifactCandidate) =>
    Math.max(candidate.createdAtMs, input.lastReferencedAtMs.get(candidate.sha256) ?? candidate.createdAtMs)
  const referenced = input.candidates
    .filter((candidate) => referencedOnly.has(candidate.sha256))
    .sort((left, right) => lastUse(left) - lastUse(right) || left.sha256.localeCompare(right.sha256))
  for (const candidate of referenced) {
    if (totalBytes - plannedDeleteBytes <= globalMaxBytes) break
    if (nowMs - candidate.createdAtMs < capacityGraceMs) continue
    if (batchFull(candidate)) break
    selected.add(candidate.sha256)
    plannedDeleteBytes += candidate.bytes
  }
  const selectedCandidates = input.candidates.filter(
    (candidate) => reachable.has(candidate.sha256) || selected.has(candidate.sha256),
  )
  const plan = planArtifactGc({ dataDir: input.dataDir, candidates: selectedCandidates, roots: input.roots })
  const executionRoots = Object.fromEntries(
    ARTIFACT_ROOT_SOURCES.map((source) => [source, { complete: true, roots: [] }]),
  ) as unknown as ArtifactReachabilityInput['roots']
  const executionPlan = planArtifactGc({
    dataDir: input.dataDir,
    candidates: input.candidates.filter((candidate) => selected.has(candidate.sha256)),
    roots: executionRoots,
  })
  const remainingBytes = totalBytes - plannedDeleteBytes
  return Object.freeze({
    plan,
    executionPlan,
    totalBytes,
    plannedDeleteBytes,
    remainingBytes,
    unresolvedPressureBytes: Math.max(0, remainingBytes - globalMaxBytes),
  })
}
