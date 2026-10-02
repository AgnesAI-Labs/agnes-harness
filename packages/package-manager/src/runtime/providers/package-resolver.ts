import type { RuntimeWireTypes } from '@agnes/protocol/runtime'
import {
  acceptWire,
  compareVersions,
  DEFAULT_RESOLVER_PROVIDER_ID,
  digestJson,
  emptyPackageLock,
  isStable,
  lockEntry,
  PACKAGE_RESOLVER_CONTRACT,
  type PackageOutcome,
  packageLock,
  readSnapshot,
  refuse,
  type SnapshotCandidate,
  type SourceSnapshotDocument,
  versionSatisfies,
  writeRuntimePackageLock,
} from '../source-snapshot.js'

export interface PackageResolverOptions {
  readonly providerId?: string
  readonly cacheDir: string
}

export interface PackageResolverProvider {
  readonly providerId: string
  readonly contract: typeof PACKAGE_RESOLVER_CONTRACT
  networkReads(): number
  processSpawns(): number
  resolve(input: unknown): PackageOutcome<RuntimeWireTypes['PackageResolverResolveResult']>
  cancel(): void
  dispose(): void
}

interface Constraint {
  readonly range: string
  readonly sourceIds: readonly string[]
  readonly optional: boolean
  readonly requiredBy: string
}

interface PackageConflict {
  readonly packageId: string
  readonly reason: string
}

type Choice =
  | { readonly kind: 'selected'; readonly candidate: SnapshotCandidate }
  | { readonly kind: 'skip' }
  | { readonly kind: 'conflict'; readonly conflict: PackageConflict }

function conflict(packageId: string, reason: string): PackageConflict {
  return { packageId, reason }
}

function sortedCopy<T>(values: readonly T[], compare: (left: T, right: T) => number): T[] {
  return values.slice().sort(compare)
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText)
}

function addConstraint(constraints: Map<string, Constraint[]>, packageId: string, item: Constraint): void {
  const list = constraints.get(packageId)
  if (list === undefined) constraints.set(packageId, [item])
  else list.push(item)
}

function seedConstraints(
  requirements: readonly RuntimeWireTypes['PackageRequirement'][],
): Map<string, Constraint[]> {
  const constraints = new Map<string, Constraint[]>()
  const ordered = sortedCopy(requirements, (left, right) => compareText(left.packageId, right.packageId))
  for (const requirement of ordered) {
    addConstraint(constraints, requirement.packageId, {
      range: requirement.versionRange,
      sourceIds: requirement.sourceIds.slice().sort(compareText),
      optional: false,
      requiredBy: '',
    })
  }
  return constraints
}

function allowedCandidate(
  candidate: SnapshotCandidate,
  allowedSources: ReadonlySet<string>,
  constraints: readonly Constraint[],
): boolean {
  if (!allowedSources.has(candidate.locator.sourceId)) return false
  for (const item of constraints) {
    if (!versionSatisfies(candidate.version, item.range)) return false
    if (item.sourceIds.length > 0 && !item.sourceIds.includes(candidate.locator.sourceId)) return false
  }
  return true
}

function choose(
  packageId: string,
  constraints: readonly Constraint[],
  snapshot: SourceSnapshotDocument,
  allowedSources: ReadonlySet<string>,
  pins: ReadonlyMap<string, RuntimeWireTypes['PackageLockEntry']>,
  apiVersions: ReadonlyMap<string, number>,
): Choice {
  const required = constraints.filter((item) => !item.optional)
  const active = required.length > 0 ? required : constraints
  let pool = snapshot.candidates.filter(
    (candidate) => candidate.packageId === packageId && allowedCandidate(candidate, allowedSources, active),
  )
  const pin = pins.get(packageId)
  if (pin !== undefined) {
    const ranges = active.map((item) => item.range).join(' ')
    if (!active.every((item) => versionSatisfies(pin.version, item.range))) {
      return {
        kind: 'conflict',
        conflict: conflict(
          packageId,
          `pin version does not satisfy /installedLock/entries/${packageId} ${pin.version} ${ranges}`,
        ),
      }
    }
    const matched = pool.filter(
      (candidate) => candidate.version === pin.version && candidate.treeDigest === pin.digest,
    )
    if (matched.length === 0) {
      const digests = unique(
        pool
          .filter((candidate) => candidate.version === pin.version)
          .map((candidate) => candidate.treeDigest),
      )
      const listed = digests.length > 0 ? digests.join(' ') : 'none'
      return {
        kind: 'conflict',
        conflict: conflict(
          packageId,
          `content identity mismatch /candidates/${packageId}@${pin.version} ${pin.digest} ${listed}`,
        ),
      }
    }
    pool = matched
  } else {
    const versions = unique(pool.map((candidate) => candidate.version))
    const stable = versions.filter((version) => isStable(version))
    const target = highest(stable.length > 0 ? stable : versions)
    if (target === undefined) {
      if (required.length === 0) return { kind: 'skip' }
      const parent = required.find((item) => item.requiredBy !== '')?.requiredBy
      const path =
        parent === undefined ? `/requirements/${packageId}` : `/packages/${parent}/dependencies/${packageId}`
      return { kind: 'conflict', conflict: conflict(packageId, `missing dependency ${path}`) }
    }
    pool = pool.filter((candidate) => candidate.version === target)
    const digests = unique(pool.map((candidate) => candidate.treeDigest))
    if (digests.length > 1) {
      return {
        kind: 'conflict',
        conflict: conflict(
          packageId,
          `content identity mismatch /candidates/${packageId}@${target} ${digests.join(' ')}`,
        ),
      }
    }
  }
  pool.sort((left, right) => compareText(left.locator.sourceId, right.locator.sourceId))
  const candidate = pool[0]
  if (candidate === undefined) {
    return {
      kind: 'conflict',
      conflict: conflict(packageId, `missing dependency /requirements/${packageId}`),
    }
  }
  for (const feature of candidate.requiredFeatures) {
    if (!snapshot.allowedFeatures.includes(feature)) {
      return {
        kind: 'conflict',
        conflict: conflict(
          packageId,
          `feature not allowed /packages/${packageId}/requiredFeatures/${feature}`,
        ),
      }
    }
  }
  for (const scope of candidate.scopes) {
    if (!snapshot.allowedScopes.includes(scope)) {
      return {
        kind: 'conflict',
        conflict: conflict(packageId, `scope not allowed /packages/${packageId}/scopes/${scope}`),
      }
    }
  }
  for (const definition of candidate.definitions) {
    const major = apiVersions.get(definition.contract)
    if (major !== undefined && major !== definition.major) {
      return {
        kind: 'conflict',
        conflict: conflict(
          packageId,
          `api major mismatch /contracts/${definition.contract}@${definition.major} requested ${major}`,
        ),
      }
    }
    if (definition.ownerPackageId !== candidate.packageId) {
      return {
        kind: 'conflict',
        conflict: conflict(
          packageId,
          `definition owner mismatch /contracts/${definition.contract}@${definition.major}`,
        ),
      }
    }
  }
  return { kind: 'selected', candidate }
}

function highest(versions: readonly string[]): string | undefined {
  let best: string | undefined
  for (const version of versions) {
    if (best === undefined || compareVersions(version, best) > 0) best = version
  }
  return best
}

function selectionKey(
  selected: ReadonlyMap<string, SnapshotCandidate>,
  conflicts: readonly PackageConflict[],
): string {
  const chosen = [...selected.entries()]
    .sort((left, right) => compareText(left[0], right[0]))
    .map(([id, candidate]) => `${id}@${candidate.version}@${candidate.treeDigest}`)
  const reasons = conflicts.map((item) => `${item.packageId}:${item.reason}`).sort(compareText)
  return `${chosen.join('|')}#${reasons.join('|')}`
}

function closeDefinitions(
  selected: ReadonlyMap<string, SnapshotCandidate>,
  conflicts: PackageConflict[],
): void {
  const groups = new Map<string, { digest: string; owner: string }[]>()
  for (const candidate of selected.values()) {
    for (const definition of candidate.definitions) {
      const key = `${definition.contract}@${definition.major}`
      const list = groups.get(key) ?? []
      list.push({ digest: definition.definitionDigest, owner: candidate.packageId })
      groups.set(key, list)
    }
  }
  for (const [key, list] of groups) {
    const digests = unique(list.map((item) => item.digest))
    if (digests.length < 2) continue
    for (const item of list) {
      conflicts.push(
        conflict(item.owner, `definition digest mismatch /contracts/${key} ${digests.join(' ')}`),
      )
    }
  }
  for (const candidate of selected.values()) {
    for (const ref of candidate.contractRefs) {
      const owner = selected.get(ref.ownerPackageId)
      const defined =
        owner?.definitions.some(
          (definition) =>
            definition.contract === ref.contract &&
            definition.major === ref.major &&
            definition.definitionDigest === ref.definitionDigest,
        ) === true
      if (defined) continue
      const privatePath = owner?.privatePaths[0]
      if (owner !== undefined && privatePath !== undefined) {
        conflicts.push(
          conflict(candidate.packageId, `private source /packages/${owner.packageId}/${privatePath}`),
        )
        continue
      }
      conflicts.push(
        conflict(
          candidate.packageId,
          `definition owner missing /contracts/${ref.contract}@${ref.major}/${ref.ownerPackageId}`,
        ),
      )
    }
  }
}

function blockDependents(
  selected: ReadonlyMap<string, SnapshotCandidate>,
  blocked: Set<string>,
  conflicts: PackageConflict[],
): void {
  let grew = true
  while (grew) {
    grew = false
    for (const candidate of selected.values()) {
      if (blocked.has(candidate.packageId)) continue
      for (const dependency of candidate.dependencies) {
        if (dependency.optional || !blocked.has(dependency.packageId)) continue
        blocked.add(candidate.packageId)
        conflicts.push(
          conflict(
            candidate.packageId,
            `depends on conflict /packages/${candidate.packageId}/dependencies/${dependency.packageId}`,
          ),
        )
        grew = true
      }
    }
  }
}

function resolveDocument(
  snapshot: SourceSnapshotDocument,
  request: RuntimeWireTypes['PackageResolverResolveRequest'],
): PackageOutcome<{
  lockGraph: RuntimeWireTypes['PackageLock']
  conflicts: PackageConflict[]
  configDigest: string
}> {
  const lockDigest = packageLock(request.installedLock.entries.slice()).digest
  if (lockDigest !== request.installedLock.digest) {
    return refuse('denied', 'lock_digest_mismatch', 'installed lock digest does not match its entries')
  }
  const allowedSources = new Set(request.allowedSources)
  const pins = new Map(request.installedLock.entries.map((entry) => [entry.packageId, entry]))
  const apiVersions = new Map(request.apiVersions.map((item) => [item.contract, item.major]))
  let selected = new Map<string, SnapshotCandidate>()
  let conflicts: PackageConflict[] = []
  let previous = ''
  for (let round = 0; round < 32; round += 1) {
    const constraints = seedConstraints(request.requirements)
    for (const candidate of selected.values()) {
      for (const dependency of candidate.dependencies) {
        addConstraint(constraints, dependency.packageId, {
          range: dependency.versionRange,
          sourceIds: [],
          optional: dependency.optional,
          requiredBy: candidate.packageId,
        })
      }
    }
    const next = new Map<string, SnapshotCandidate>()
    const nextConflicts: PackageConflict[] = []
    for (const packageId of [...constraints.keys()].sort(compareText)) {
      const constraintsForPackage = constraints.get(packageId) ?? []
      const outcome = choose(packageId, constraintsForPackage, snapshot, allowedSources, pins, apiVersions)
      if (outcome.kind === 'conflict') nextConflicts.push(outcome.conflict)
      else if (outcome.kind === 'selected') next.set(packageId, outcome.candidate)
    }
    const key = selectionKey(next, nextConflicts)
    selected = next
    conflicts = nextConflicts
    if (key === previous) break
    previous = key
  }
  closeDefinitions(selected, conflicts)
  const blocked = new Set(conflicts.map((item) => item.packageId))
  blockDependents(selected, blocked, conflicts)
  const entries: RuntimeWireTypes['PackageLockEntry'][] = []
  for (const candidate of [...selected.values()].sort((left, right) =>
    compareText(left.packageId, right.packageId),
  )) {
    if (blocked.has(candidate.packageId)) continue
    const dependencies = candidate.dependencies
      .filter((dependency) => {
        const chosen = selected.get(dependency.packageId)
        return chosen !== undefined && !blocked.has(dependency.packageId)
      })
      .sort((left, right) => compareText(left.packageId, right.packageId))
      .map((dependency) => ({
        packageId: dependency.packageId,
        digest: selected.get(dependency.packageId)?.treeDigest ?? '',
      }))
    const entry = lockEntry(candidate, dependencies)
    if (!entry.ok) return entry
    entries.push(entry.value)
  }
  const configDigest = digestJson({
    allowedSources: request.allowedSources.slice().sort(compareText),
    apiVersions: request.apiVersions
      .slice()
      .sort((left, right) => compareText(left.contract, right.contract)),
    platform: request.platform,
    requirements: sortedCopy(request.requirements, (left, right) =>
      compareText(left.packageId, right.packageId),
    ).map((requirement) => ({
      packageId: requirement.packageId,
      sourceIds: requirement.sourceIds.slice().sort(compareText),
      versionRange: requirement.versionRange,
    })),
    revision: snapshot.revision,
    snapshotId: snapshot.snapshotId,
  })
  return {
    ok: true,
    value: {
      lockGraph: entries.length === 0 ? emptyPackageLock() : packageLock(entries),
      conflicts: conflicts
        .slice()
        .sort(
          (left, right) =>
            compareText(left.packageId, right.packageId) || compareText(left.reason, right.reason),
        ),
      configDigest,
    },
  }
}

export function createPackageResolverProvider(options: PackageResolverOptions): PackageResolverProvider {
  const providerId = options.providerId ?? DEFAULT_RESOLVER_PROVIDER_ID
  let disposed = false
  let cancelled = false
  const gate = (): PackageOutcome<null> => {
    if (disposed) return refuse('internal', 'provider_disposed', 'package resolver is disposed')
    if (cancelled) return refuse('cancelled', 'operation_cancelled', 'package resolve is cancelled')
    return { ok: true, value: null }
  }
  return {
    providerId,
    contract: PACKAGE_RESOLVER_CONTRACT,
    networkReads: () => 0,
    processSpawns: () => 0,
    resolve(input) {
      const open = gate()
      if (!open.ok) return open
      const request = acceptWire('PackageResolverResolveRequest', input)
      if (!request.ok) return request
      const snapshot = readSnapshot(options.cacheDir)
      if (!snapshot.ok) return snapshot
      const resolved = resolveDocument(snapshot.value, request.value)
      if (!resolved.ok) return resolved
      const result = acceptWire('PackageResolverResolveResult', resolved.value)
      if (!result.ok) return result
      writeRuntimePackageLock(options.cacheDir, result.value.lockGraph)
      return result
    },
    cancel() {
      cancelled = true
    },
    dispose() {
      disposed = true
      cancelled = true
    },
  }
}

export { emptyPackageLock }
