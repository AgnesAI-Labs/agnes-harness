import {
  ARTIFACT_ROOT_SOURCES,
  type ArtifactGcPlan,
  type ArtifactPlanEntry,
  type ArtifactRootSource,
  artifactStorePath,
} from './reachability.js'

const SHA256 = /^[0-9a-f]{64}$/u
const ROOT_SOURCES = new Set<string>(ARTIFACT_ROOT_SOURCES)
const MAX_PLAN_ENTRIES = 4096
const PREPARED_PREREQUISITES = new WeakSet<object>()

export type ArtifactGcPreparationRuntime = Readonly<{
  isProxy(value: unknown): boolean
  canonicalDataDir(value: string): string | undefined
  rootRelativePath(dataDir: string, path: string): string | undefined
  sha256Utf8(value: string): string
}>

const HOST_REQUIREMENTS = Object.freeze([
  'open-data-root-directory-handle-no-follow',
  'acquire-exclusive-reachability-and-deletion-lock',
  'recompute-ledger-request-media-export-retention-rollback-roots-under-lock-before-each-unlink',
  'prove-each-ledger-session-prefix-unchanged-under-lock-by-anchor-id-and-hash-chained-integrity-digest-or-id-alone-for-legacy-rows-without-digest',
  're-extract-every-ledger-row-after-each-anchor-under-lock-and-match-bound-snapshot-epoch-hash',
  'open-each-candidate-path-component-as-held-no-follow-directory-handle',
  'require-regular-file-single-link',
  'bind-open-file-handle-to-parent-entry-dev-ino-or-file-id',
  'recompute-sha256-from-open-handle',
  'revalidate-open-handle-and-parent-entry-identity-immediately-before-unlink',
  'unlink-by-parent-directory-handle-and-basename',
  'abort-batch-on-any-identity-change',
  'fsync-parent-directory-handle-before-success',
] as const)

export type ArtifactGcHostCandidate = Readonly<{
  sha256: string
  rootRelativePath: string
}>

export type ArtifactGcReachabilitySnapshotIdentity = Readonly<{
  epoch: string
  hash: string
}>

export type ArtifactGcExecutionPrerequisite = Readonly<{
  /** Neutral attestation; a platform-specific native capability must explicitly promote it. */
  mode: 'dry-run-attestation'
  blocked: true
  blocker: 'fd-relative-host-capability-unavailable'
  authority: 'none'
  planHash: string
  dataDir: string
  reachabilitySnapshot: ArtifactGcReachabilitySnapshotIdentity
  candidates: readonly ArtifactGcHostCandidate[]
  hostRequirements: typeof HOST_REQUIREMENTS
}>

/** Internal provenance check used by the physical executor; structural lookalikes are not authority. */
export function isPreparedArtifactGcExecutionPrerequisite(
  value: unknown,
): value is ArtifactGcExecutionPrerequisite {
  return typeof value === 'object' && value !== null && PREPARED_PREREQUISITES.has(value)
}

function fail(reason: string): never {
  throw new Error(`artifact GC execution prerequisite ${reason}`)
}

function exactOwn(
  value: unknown,
  fields: readonly string[],
  runtime: ArtifactGcPreparationRuntime,
): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || runtime.isProxy(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key)) ||
    fields.some((key) => {
      const descriptor = descriptors[key]
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
    })
  )
    return undefined
  const snapshot = Object.create(null) as Record<string, unknown>
  for (const field of fields) snapshot[field] = descriptors[field]?.value
  return Object.freeze(snapshot)
}

function denseArray(
  value: unknown,
  maximum: number,
  runtime: ArtifactGcPreparationRuntime,
): readonly unknown[] | undefined {
  if (!Array.isArray(value) || runtime.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return undefined
  const copy: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined
    copy.push(descriptor.value)
  }
  if (Reflect.ownKeys(descriptors).length !== length + 1) return undefined
  return Object.freeze(copy)
}

function canonicalDataDir(value: unknown, runtime: ArtifactGcPreparationRuntime): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\0') ||
    value !== value.normalize('NFC') ||
    runtime.canonicalDataDir(value) !== value
  )
    return fail('requires an absolute canonical dataDir')
  return value
}

function snapshotReachabilityIdentity(
  value: unknown,
  runtime: ArtifactGcPreparationRuntime,
): ArtifactGcReachabilitySnapshotIdentity {
  const snapshot = exactOwn(value, ['epoch', 'hash'], runtime)
  if (
    !snapshot ||
    typeof snapshot.epoch !== 'string' ||
    snapshot.epoch.length < 1 ||
    snapshot.epoch.length > 256 ||
    snapshot.epoch !== snapshot.epoch.normalize('NFC') ||
    [...snapshot.epoch].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    }) ||
    typeof snapshot.hash !== 'string' ||
    !SHA256.test(snapshot.hash)
  )
    return fail('requires a canonical reachability snapshot identity')
  return Object.freeze({ epoch: snapshot.epoch, hash: snapshot.hash })
}

function snapshotSources(
  value: unknown,
  runtime: ArtifactGcPreparationRuntime,
): readonly ArtifactRootSource[] {
  const array = denseArray(value, ARTIFACT_ROOT_SOURCES.length, runtime)
  if (
    !array ||
    array.some((source) => typeof source !== 'string' || !ROOT_SOURCES.has(source)) ||
    new Set(array).size !== array.length
  )
    return fail('contains invalid reachability sources')
  const sources = array as ArtifactRootSource[]
  const sorted = [...sources].sort((left, right) => left.localeCompare(right))
  if (sources.some((source, index) => source !== sorted[index]))
    return fail('reachability sources are not deterministic')
  return Object.freeze([...sources])
}

function snapshotEntry(
  value: unknown,
  dataDir: string,
  runtime: ArtifactGcPreparationRuntime,
): ArtifactPlanEntry {
  const entry = exactOwn(value, ['sha256', 'path', 'reachableFrom'], runtime)
  if (
    !entry ||
    typeof entry.sha256 !== 'string' ||
    !SHA256.test(entry.sha256) ||
    typeof entry.path !== 'string' ||
    entry.path !== artifactStorePath(dataDir, entry.sha256)
  )
    return fail('contains an entry with invalid content/path identity')
  return Object.freeze({
    sha256: entry.sha256,
    path: entry.path,
    reachableFrom: snapshotSources(entry.reachableFrom, runtime),
  })
}

function snapshotEntries(
  value: unknown,
  dataDir: string,
  runtime: ArtifactGcPreparationRuntime,
): readonly ArtifactPlanEntry[] {
  const array = denseArray(value, MAX_PLAN_ENTRIES, runtime)
  if (!array) return fail('contains an invalid candidate list')
  const entries = array.map((entry) => snapshotEntry(entry, dataDir, runtime))
  const sorted = [...entries].sort((left, right) => left.sha256.localeCompare(right.sha256))
  if (entries.some((entry, index) => entry.sha256 !== sorted[index]?.sha256))
    return fail('candidate list is not deterministic')
  return Object.freeze(entries)
}

function snapshotPlan(
  value: unknown,
  dataDir: string,
  runtime: ArtifactGcPreparationRuntime,
): {
  kept: readonly ArtifactPlanEntry[]
  eligible: readonly ArtifactPlanEntry[]
} {
  const plan = exactOwn(value, ['mode', 'blocked', 'issues', 'kept', 'eligibleForDeletion'], runtime)
  if (plan?.mode !== 'dry-run' || plan.blocked !== false) return fail('requires an unblocked dry-run plan')
  const issues = denseArray(plan.issues, 256, runtime)
  if (issues?.length !== 0) return fail('requires a complete issue-free plan')
  const kept = snapshotEntries(plan.kept, dataDir, runtime)
  const eligible = snapshotEntries(plan.eligibleForDeletion, dataDir, runtime)
  if (kept.some((entry) => entry.reachableFrom.length === 0))
    return fail('kept entry lacks a complete reachability root')
  if (eligible.some((entry) => entry.reachableFrom.length !== 0))
    return fail('deletion candidate is still reachable')
  const identities = [...kept, ...eligible].map((entry) => entry.sha256)
  if (new Set(identities).size !== identities.length) return fail('plan contains duplicate identities')
  return { kept, eligible }
}

/**
 * Converts a complete, unblocked planner result into a deterministic Host request, while remaining
 * deliberately non-executable. Windows/macOS Host code may promote it only after binding a native
 * same-handle/openat capability; other platforms remain blocked rather than approximating deletion
 * with lstat/realpath checks vulnerable to replacement races.
 */
export function prepareArtifactGcExecutionPrerequisite(
  input: {
    dataDir: string
    plan: ArtifactGcPlan | unknown
    reachabilitySnapshot: ArtifactGcReachabilitySnapshotIdentity | unknown
  },
  runtime: ArtifactGcPreparationRuntime,
): ArtifactGcExecutionPrerequisite {
  const request = exactOwn(input, ['dataDir', 'plan', 'reachabilitySnapshot'], runtime)
  if (!request) return fail('requires an exact request snapshot')
  const dataDir = canonicalDataDir(request.dataDir, runtime)
  const reachabilitySnapshot = snapshotReachabilityIdentity(request.reachabilitySnapshot, runtime)
  const plan = snapshotPlan(request.plan, dataDir, runtime)
  const candidates = Object.freeze(
    plan.eligible.map((entry) => {
      const rootRelativePath = runtime.rootRelativePath(dataDir, entry.path)
      if (!rootRelativePath) return fail('candidate escapes the data root')
      return Object.freeze({
        sha256: entry.sha256,
        rootRelativePath,
      })
    }),
  )
  const planHash = runtime.sha256Utf8(
    JSON.stringify({
      dataDir,
      reachabilitySnapshot,
      kept: plan.kept,
      eligibleForDeletion: plan.eligible,
    }),
  )
  if (!SHA256.test(planHash)) return fail('runtime returned an invalid plan hash')
  const prepared = Object.freeze({
    mode: 'dry-run-attestation' as const,
    blocked: true as const,
    blocker: 'fd-relative-host-capability-unavailable' as const,
    authority: 'none' as const,
    planHash,
    dataDir,
    reachabilitySnapshot,
    candidates,
    hostRequirements: HOST_REQUIREMENTS,
  })
  PREPARED_PREREQUISITES.add(prepared)
  return prepared
}
