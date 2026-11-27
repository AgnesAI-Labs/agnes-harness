import type { Semver } from '@agnes/extension-api'
import { evaluateSemverRange } from '@agnes/extension-api/host'
import {
  type PackageCatalogPage,
  type PackageCommunityCompatibility,
  type PackageCommunityVersionV3,
  validatePackageAdminData,
  validatePackageCatalogSnapshotVersion,
} from '@agnes/protocol'

type WireSnapshot = NonNullable<PackageCatalogPage['communityIndex']>
type WireItem = WireSnapshot['items'][number]
type AghEngine = { kind: 'undeclared' } | { kind: 'invalid' } | { kind: 'range'; range: string }
export type CommunityVersion = Omit<PackageCommunityVersionV3, 'compatibility'> & { aghEngine?: AghEngine }
export type CommunityItem = Omit<WireItem, 'versions'> & { versions?: CommunityVersion[] }
export type CommunitySnapshot = Omit<WireSnapshot, 'items'> & { items: CommunityItem[] }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizedRange(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 500) return undefined
  const range = value.trim()
  return evaluateSemverRange(range, null) === 'unavailable' ? range : undefined
}

export function readAghEngine(engines: unknown): AghEngine {
  if (engines === undefined) return { kind: 'undeclared' }
  if (!record(engines)) return { kind: 'invalid' }
  if (!Object.hasOwn(engines, 'agh')) return { kind: 'undeclared' }
  const range = normalizedRange(engines.agh)
  return range === undefined ? { kind: 'invalid' } : { kind: 'range', range }
}

function compatibility(
  engine: AghEngine | undefined,
  daemonVersion: Semver | null,
): PackageCommunityCompatibility {
  if (engine?.kind === 'undeclared') return { kind: 'undeclared' }
  if (engine?.kind !== 'range') return { kind: 'unknown' }
  const { range } = engine
  switch (evaluateSemverRange(range, daemonVersion)) {
    case 'match':
      return { kind: 'declared-compatible', range }
    case 'no-match':
      return { kind: 'incompatible', range }
    case 'unavailable':
      return { kind: 'unknown', range }
    case 'unsupported':
      return { kind: 'unknown' }
  }
}

export function projectCommunitySnapshot(
  snapshot: CommunitySnapshot,
  wireVersion: 2 | 3,
  daemonVersion: Semver | null = null,
): WireSnapshot {
  return {
    ...snapshot,
    items: snapshot.items.map((item) => {
      if (!item.versions) return item
      return {
        ...item,
        versions: item.versions.map(({ version, source, provides, publishTimestamp, aghEngine }) => ({
          version,
          source,
          ...(wireVersion === 3
            ? {
                ...(provides === undefined ? {} : { provides }),
                ...(publishTimestamp === undefined ? {} : { publishTimestamp }),
                compatibility: compatibility(aghEngine, daemonVersion),
              }
            : {}),
        })),
      }
    }),
  }
}

function validAghEngine(value: unknown): boolean {
  if (!record(value)) return false
  if (value.kind === 'range')
    return (
      Object.keys(value).length === 2 &&
      typeof value.range === 'string' &&
      normalizedRange(value.range) === value.range
    )
  return Object.keys(value).length === 1 && (value.kind === 'undeclared' || value.kind === 'invalid')
}

/** The wire schema also guards cached identity and presentation fields. Engine facts never go on the wire. */
export function isCommunitySnapshot(value: unknown, cacheVersion: 4 | 5): value is CommunitySnapshot {
  if (!record(value) || !Array.isArray(value.items)) return false
  let projected: unknown = value
  if (cacheVersion === 5) {
    const items: unknown[] = []
    for (const item of value.items) {
      if (!record(item)) return false
      if (!Array.isArray(item.versions)) {
        items.push(item)
        continue
      }
      const versions: unknown[] = []
      for (const stored of item.versions) {
        if (!record(stored) || Object.hasOwn(stored, 'compatibility')) return false
        const { aghEngine, ...presentation } = stored
        if (aghEngine !== undefined && !validAghEngine(aghEngine)) return false
        versions.push({ ...presentation, compatibility: { kind: 'unknown' } })
      }
      items.push({ ...item, versions })
    }
    projected = { ...value, items }
  }
  const checked = validatePackageAdminData('PackageCatalogPage', {
    items: [],
    nextCursor: null,
    communityIndex: projected,
  })
  return (
    checked.ok &&
    validatePackageCatalogSnapshotVersion(checked.value as PackageCatalogPage, cacheVersion === 4 ? 2 : 3)
  )
}
