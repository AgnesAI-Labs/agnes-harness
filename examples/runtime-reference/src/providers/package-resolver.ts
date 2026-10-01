import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type JsonValue,
  type RuntimeWireTypes,
} from '@agnes/protocol/runtime'
import {
  acceptWire,
  packageEntry,
  type ReferenceOutcome,
  readShelf,
  refuse,
  type ShelfRow,
} from './local-tree.js'

const RESOLVER_CONTRACT = 'agh.package-resolver' as const
const DEFAULT_ID = 'agh.reference/package-resolver'
const LOCK_FILE = 'runtime-package-lock.json'
const LIMITS = { maxBytes: 1_000_000, maxDepth: 32, maxMembers: 10_000 } as const

export interface ReferenceResolverOptions {
  readonly providerId?: string
  readonly cacheDir: string
}

interface Requirement {
  readonly packageId: string
  readonly versionRange: string
  readonly sourceIds: readonly string[]
}

function textOrder(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function lockOf(entries: RuntimeWireTypes['PackageLockEntry'][]): RuntimeWireTypes['PackageLock'] {
  const sorted = entries.slice().sort((left, right) => textOrder(left.packageId, right.packageId))
  return { entries: sorted, digest: canonicalJsonDigest(sorted as JsonValue) }
}

function writeLock(cacheDir: string, lock: RuntimeWireTypes['PackageLock']): ReferenceOutcome<null> {
  const encoded = boundedCanonicalJson(lock, LIMITS)
  if (!encoded.ok) return refuse('invalid_input', 'schema_invalid', 'package lock is not canonical JSON')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, LOCK_FILE), `${encoded.value.canonical}\n`)
  return { ok: true, value: null }
}

function matches(row: ShelfRow, requirement: Requirement, allowed: ReadonlySet<string>): boolean {
  if (row.packageId !== requirement.packageId || row.version !== requirement.versionRange) return false
  if (!allowed.has(row.sourceId)) return false
  if (requirement.sourceIds.length > 0 && !requirement.sourceIds.includes(row.sourceId)) return false
  return true
}

export function createPackageResolverProvider(options: ReferenceResolverOptions) {
  const providerId = options.providerId ?? DEFAULT_ID
  let disposed = false
  let cancelled = false
  const gate = (): ReferenceOutcome<null> => {
    if (disposed) return refuse('internal', 'provider_disposed', 'reference package resolver is disposed')
    if (cancelled) return refuse('cancelled', 'operation_cancelled', 'reference package resolve is cancelled')
    return { ok: true, value: null }
  }

  return {
    providerId,
    contract: RESOLVER_CONTRACT,
    networkReads: (): number => 0,
    processSpawns: (): number => 0,
    resolve(input: unknown): ReferenceOutcome<RuntimeWireTypes['PackageResolverResolveResult']> {
      const open = gate()
      if (!open.ok) return open
      const request = acceptWire('PackageResolverResolveRequest', input)
      if (!request.ok) return request
      const stated = canonicalJsonDigest(request.value.installedLock.entries as JsonValue)
      if (stated !== request.value.installedLock.digest) {
        return refuse('denied', 'lock_digest_mismatch', 'installed lock digest does not match its entries')
      }
      const shelf = readShelf(options.cacheDir)
      if (!shelf.ok) return shelf
      const allowed = new Set(request.value.allowedSources)
      const pins = new Map(request.value.installedLock.entries.map((entry) => [entry.packageId, entry]))
      const conflicts: { packageId: string; reason: string }[] = []
      const chosen: ShelfRow[] = []
      const seen = new Set<string>()
      const requirements = request.value.requirements
        .slice()
        .sort((left, right) => textOrder(left.packageId, right.packageId))
      for (const requirement of requirements) {
        if (seen.has(requirement.packageId)) continue
        seen.add(requirement.packageId)
        const pool = shelf.value.rows.filter((row) => matches(row, requirement, allowed))
        const pin = pins.get(requirement.packageId)
        const picked =
          pin === undefined ? pickFresh(requirement.packageId, pool) : pickPin(requirement, pool, pin)
        if (picked.ok === false) conflicts.push({ packageId: requirement.packageId, reason: picked.reason })
        else chosen.push(picked.row)
      }
      const entries: RuntimeWireTypes['PackageLockEntry'][] = []
      for (const row of chosen) {
        const entry = packageEntry(row)
        if (!entry.ok) return entry
        entries.push(entry.value)
      }
      const lockGraph = lockOf(entries)
      const configDigest = canonicalJsonDigest(
        JSON.parse(
          JSON.stringify({
            allowedSources: request.value.allowedSources.slice().sort(textOrder),
            platform: request.value.platform,
            requirements: requirements.map((item) => ({
              packageId: item.packageId,
              sourceIds: item.sourceIds.slice().sort(textOrder),
              versionRange: item.versionRange,
            })),
            revision: shelf.value.revision,
            snapshotId: shelf.value.snapshotId,
          }),
        ) as JsonValue,
      )
      const result = acceptWire('PackageResolverResolveResult', {
        lockGraph,
        conflicts: conflicts
          .slice()
          .sort(
            (left, right) =>
              textOrder(left.packageId, right.packageId) || textOrder(left.reason, right.reason),
          ),
        configDigest,
      })
      if (!result.ok) return result
      const stored = writeLock(options.cacheDir, result.value.lockGraph)
      if (!stored.ok) return stored
      return result
    },
    cancel(): void {
      cancelled = true
    },
    dispose(): void {
      disposed = true
      cancelled = true
    },
  }
}

function pickFresh(
  packageId: string,
  pool: readonly ShelfRow[],
): { ok: true; row: ShelfRow } | { ok: false; reason: string } {
  const ranked = pool.slice().sort((left, right) => textOrder(left.sourceId, right.sourceId))
  const digests = [...new Set(ranked.map((row) => row.treeDigest))].sort(textOrder)
  const version = ranked[0]?.version
  if (version === undefined) return { ok: false, reason: `missing dependency /requirements/${packageId}` }
  if (digests.length > 1) {
    return {
      ok: false,
      reason: `content identity mismatch /candidates/${packageId}@${version} ${digests.join(' ')}`,
    }
  }
  const row = ranked[0]
  if (row === undefined) return { ok: false, reason: `missing dependency /requirements/${packageId}` }
  return { ok: true, row }
}

function pickPin(
  requirement: Requirement,
  pool: readonly ShelfRow[],
  pin: RuntimeWireTypes['PackageLockEntry'],
): { ok: true; row: ShelfRow } | { ok: false; reason: string } {
  if (pin.version !== requirement.versionRange) {
    return {
      ok: false,
      reason: `pin version does not satisfy /installedLock/entries/${requirement.packageId} ${pin.version} ${requirement.versionRange}`,
    }
  }
  const matched = pool
    .filter((row) => row.version === pin.version && row.treeDigest === pin.digest)
    .slice()
    .sort((left, right) => textOrder(left.sourceId, right.sourceId))
  const row = matched[0]
  if (row !== undefined) return { ok: true, row }
  const listed = [
    ...new Set(pool.filter((item) => item.version === pin.version).map((item) => item.treeDigest)),
  ].sort(textOrder)
  const text = listed.length > 0 ? listed.join(' ') : 'none'
  return {
    ok: false,
    reason: `content identity mismatch /candidates/${requirement.packageId}@${pin.version} ${pin.digest} ${text}`,
  }
}
