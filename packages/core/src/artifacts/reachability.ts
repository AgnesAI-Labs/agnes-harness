const SHA256 = /^[0-9a-f]{64}$/

export const ARTIFACT_ROOT_SOURCES = ['ledger', 'request-media', 'export', 'retention', 'rollback'] as const

export type ArtifactRootSource = (typeof ARTIFACT_ROOT_SOURCES)[number]

export type ArtifactRoot = Readonly<{
  sha256: string
  /** Required for request-media roots and checked whenever another source supplies it. */
  artifactUri?: string
}>

export type ArtifactRootSnapshot = Readonly<{
  /** False means the owner could not produce a complete global scan. GC must then fail closed. */
  complete: boolean
  roots: readonly ArtifactRoot[]
}>

export type StoredArtifactCandidate = Readonly<{
  sha256: string
  /** Digest recomputed from the stored bytes by the scanner, not copied from the file name. */
  contentSha256: string
  /** The exact dataFs path returned by artifactStorePath for this digest. */
  path: string
}>

export type ArtifactReachabilityInput = Readonly<{
  dataDir: string
  candidates: readonly StoredArtifactCandidate[]
  roots: Readonly<Record<ArtifactRootSource, ArtifactRootSnapshot>>
  /**
   * Deliberately advisory. The per-session recent-20 list is a UI/dedup index, not a byte root and
   * not evidence that an artifact is safe to delete. Changing it cannot change this plan.
   */
  recentMetadataDigests?: readonly string[]
}>

export type ArtifactPlanEntry = Readonly<{
  sha256: string
  path: string
  reachableFrom: readonly ArtifactRootSource[]
}>

export type ArtifactGcPlan = Readonly<{
  /** This module only marks and plans; the separately authorized executor owns physical deletion. */
  mode: 'dry-run'
  blocked: boolean
  issues: readonly string[]
  kept: readonly ArtifactPlanEntry[]
  eligibleForDeletion: readonly ArtifactPlanEntry[]
}>

/** Mirrors artifacts-local's content-addressed layout without normalizing an attacker-controlled path. */
export function artifactStorePath(dataDir: string, sha256: string): string {
  return `${dataDir}/artifacts/sha256/${sha256.slice(0, 2)}/${sha256}`
}

function validDataDir(dataDir: string): boolean {
  return dataDir.length > 0 && !dataDir.includes('\0')
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

/**
 * Produces a deterministic deletion proposal from already-normalized, complete root snapshots.
 * Discovering ledger/export/rollback roots remains the owning subsystem's responsibility: this
 * function never guesses through arbitrary JSON, and any incomplete or inconsistent scan blocks
 * every deletion candidate.
 */
export function planArtifactGc(input: ArtifactReachabilityInput): ArtifactGcPlan {
  const issues: string[] = []
  if (!validDataDir(input.dataDir)) issues.push('dataDir must be a non-empty NUL-free path')

  const candidates = new Map<string, StoredArtifactCandidate>()
  for (const candidate of input.candidates) {
    if (!SHA256.test(candidate.sha256)) {
      issues.push('candidate has an invalid sha256')
      continue
    }
    if (!SHA256.test(candidate.contentSha256) || candidate.contentSha256 !== candidate.sha256)
      issues.push(`candidate ${candidate.sha256} content digest does not match its name`)
    const expected = artifactStorePath(input.dataDir, candidate.sha256)
    if (candidate.path !== expected)
      issues.push(`candidate ${candidate.sha256} path does not match its content digest`)
    const prior = candidates.get(candidate.sha256)
    if (prior) {
      issues.push(`candidate ${candidate.sha256} duplicates a content digest`)
      if (candidate.path.localeCompare(prior.path) < 0) candidates.set(candidate.sha256, candidate)
    } else candidates.set(candidate.sha256, candidate)
  }

  const sourcesByDigest = new Map<string, Set<ArtifactRootSource>>()
  for (const source of ARTIFACT_ROOT_SOURCES) {
    const snapshot = input.roots[source]
    if (snapshot?.complete !== true) {
      issues.push(`${source} root scan is incomplete`)
      continue
    }
    for (const root of snapshot.roots) {
      if (!SHA256.test(root.sha256)) {
        issues.push(`${source} root has an invalid sha256`)
        continue
      }
      const expectedUri = `artifact://${root.sha256}`
      if (source === 'request-media' && root.artifactUri === undefined)
        issues.push(`${source} root ${root.sha256} is missing artifactUri`)
      else if (root.artifactUri !== undefined && root.artifactUri !== expectedUri)
        issues.push(`${source} root ${root.sha256} artifactUri does not match its content digest`)
      let sources = sourcesByDigest.get(root.sha256)
      if (!sources) {
        sources = new Set()
        sourcesByDigest.set(root.sha256, sources)
      }
      sources.add(source)
    }
  }

  for (const sha256 of sourcesByDigest.keys())
    if (!candidates.has(sha256)) issues.push(`reachable artifact ${sha256} is missing from the store scan`)

  const blocked = issues.length > 0
  const kept: ArtifactPlanEntry[] = []
  const eligibleForDeletion: ArtifactPlanEntry[] = []
  const orderedCandidates = [...candidates.values()].sort((a, b) =>
    a.sha256 === b.sha256 ? a.path.localeCompare(b.path) : a.sha256.localeCompare(b.sha256),
  )
  for (const candidate of orderedCandidates) {
    const entry = Object.freeze({
      sha256: candidate.sha256,
      path: candidate.path,
      reachableFrom: Object.freeze(
        [...(sourcesByDigest.get(candidate.sha256) ?? [])].sort((a, b) => a.localeCompare(b)),
      ),
    })
    if (blocked || entry.reachableFrom.length > 0) kept.push(entry)
    else eligibleForDeletion.push(entry)
  }

  return Object.freeze({
    mode: 'dry-run',
    blocked,
    issues: Object.freeze(sortedUnique(issues)),
    kept: Object.freeze(kept),
    eligibleForDeletion: Object.freeze(eligibleForDeletion),
  })
}
