import { Context, type Fiber } from '@agnes/cordis'
import { type EntryRow, EntryTree } from '@agnes/cordis-loader'
import { type FiberLease, FiberLeases } from '../src/lease.js'
import {
  type BuiltinRowMountFactory,
  createVerifiedRowTestHost,
  type RowImporter,
  resolveRowImporter,
  type ThirdPartyRowMountFactory,
  type VerifiedExtrasEnvelope,
  type VerifiedRowEntry,
  type VerifiedRowInstallation,
  type VerifiedRowMount,
} from '../src/row-mount.js'
import type { RowOrigin, RowOriginLookup } from '../src/row-origin.js'

export interface VerifiedTestSnapshotRef {
  readonly packageId: string
  readonly snapshotId: string
  readonly digest: string
  readonly exports: readonly string[]
  readonly generation: number
}

export interface VerifiedTestFixture {
  readonly trust: 'third-party' | 'builtin-test'
  readonly snapshot: VerifiedTestSnapshotRef
  readonly entry: VerifiedRowEntry
  readonly entryRevision: string
  readonly extrasRevision: string
  readonly exactExtras?: Readonly<{
    slot: string
    values: Readonly<Record<string, unknown>>
  }>
  readonly preboundLease?: FiberLease
  readonly cleanup?: () => void | Promise<void>
}

export interface BuiltinTestRowMountFactory {
  create(input: {
    row: Readonly<EntryRow>
    entry: VerifiedRowEntry
    extras?: VerifiedExtrasEnvelope
  }): Promise<VerifiedRowMount>
}

export interface VerifiedTestRootOptions {
  leases?: FiberLeases
  importers?: (
    factories: Readonly<{
      thirdParty: ThirdPartyRowMountFactory
      builtin: BuiltinTestRowMountFactory
    }>,
  ) => readonly RowImporter[]
}

export interface VerifiedTestRoot {
  root: Context
  tree: EntryTree<VerifiedRowMount, VerifiedRowInstallation>
  leases: FiberLeases
  origins: { lookup(fiber: Fiber): Readonly<RowOrigin> | undefined }
  fixtures: {
    snapshot(input: {
      packageId: string
      snapshotId: string
      digest: string
      exports: readonly string[]
    }): VerifiedTestSnapshotRef
    claim(plugin: string, fixture: VerifiedTestFixture): void
    remove(plugin: string): void
  }
  apply(rows: readonly EntryRow[]): Promise<void>
}

function sameValueShape(expected: unknown, actual: unknown): boolean {
  if (expected === null || actual === null) return expected === actual
  if (Array.isArray(expected)) return Array.isArray(actual)
  if (typeof expected !== 'object') return typeof expected === typeof actual
  if (typeof actual !== 'object' || Array.isArray(actual)) return false
  const expectedRecord = expected as Record<string, unknown>
  const actualRecord = actual as Record<string, unknown>
  const keys = Object.keys(expectedRecord).sort()
  if (keys.join('\0') !== Object.keys(actualRecord).sort().join('\0')) return false
  return keys.every((key) => sameValueShape(expectedRecord[key], actualRecord[key]))
}

function exportNameOf(plugin: string, snapshot: VerifiedTestSnapshotRef): string | undefined {
  const prefix = `${snapshot.packageId}@${snapshot.snapshotId}/`
  return plugin.startsWith(prefix) ? plugin.slice(prefix.length) : undefined
}

/** Build the sole supported black-box installation world for plugin-runtime tests. */
export function createVerifiedTestRoot(options: VerifiedTestRootOptions = {}): VerifiedTestRoot {
  const root = new Context()
  const claims = new Map<string, VerifiedTestFixture>()
  const snapshots = new Map<string, VerifiedTestSnapshotRef>()
  let generation = 0
  const leases = options.leases ?? new FiberLeases()
  const runtime = createVerifiedRowTestHost({
    root,
    leases,
    snapshots: {
      async verify(candidate) {
        const snapshot = snapshots.get(`${candidate.packageId}\0${candidate.snapshotId}`)
        if (!snapshot) throw new Error('test snapshot is not installed')
        return { ...snapshot, trusted: true }
      },
    },
    exactExtras: {
      verify(input) {
        const fixture = claims.get(input.row.plugin)
        if (!fixture?.exactExtras || fixture.exactExtras.slot !== input.slot) {
          throw new Error('test exact extras slot is not registered')
        }
        if (!sameValueShape(fixture.exactExtras.values, input.values)) {
          throw new Error('test exact extras failed schema validation')
        }
        return input.values
      },
    },
  })
  const builtin: BuiltinRowMountFactory = runtime.builtin
  const fixtureImporter: RowImporter = async (row) => {
    const fixture = claims.get(row.plugin)
    if (!fixture) return undefined
    if (fixture.entryRevision !== row.entryRevision || fixture.extrasRevision !== row.extrasRevision) {
      throw new Error('test fixture revision does not match row')
    }
    const extras = fixture.exactExtras
      ? {
          slot: fixture.exactExtras.slot,
          revision: fixture.extrasRevision,
          values: fixture.exactExtras.values,
        }
      : undefined
    if (fixture.trust === 'builtin-test') {
      return builtin.create({ row, entry: fixture.entry, ...(extras ? { extras } : {}) })
    }
    const exportName = exportNameOf(row.plugin, fixture.snapshot)
    if (!exportName) throw new Error('test fixture plugin does not match snapshot')
    return runtime.thirdParty.verifyAndCreate({
      snapshot: {
        packageId: fixture.snapshot.packageId,
        snapshotId: fixture.snapshot.snapshotId,
        exportName,
        generation: fixture.snapshot.generation,
      },
      row,
      entry: fixture.entry,
      ...(extras ? { extras } : {}),
      ...(fixture.preboundLease ? { preboundLease: fixture.preboundLease } : {}),
      ...(fixture.cleanup ? { cleanup: fixture.cleanup } : {}),
    })
  }
  const importers = options.importers?.({ thirdParty: runtime.thirdParty, builtin }) ?? []
  const tree = new EntryTree(root, resolveRowImporter(...importers, fixtureImporter), runtime.adapter)
  const origins: RowOriginLookup = runtime.origins

  return Object.freeze({
    root,
    tree,
    leases,
    origins,
    fixtures: Object.freeze({
      snapshot(input: {
        packageId: string
        snapshotId: string
        digest: string
        exports: readonly string[]
      }): VerifiedTestSnapshotRef {
        const key = `${input.packageId}\0${input.snapshotId}`
        if (snapshots.has(key)) throw new Error('test snapshot is already installed')
        const snapshot = Object.freeze({
          ...input,
          exports: Object.freeze([...input.exports]),
          generation: ++generation,
        })
        snapshots.set(key, snapshot)
        return snapshot
      },
      claim(plugin: string, fixture: VerifiedTestFixture): void {
        if (claims.has(plugin)) throw new Error(`duplicate test fixture claim: ${plugin}`)
        claims.set(plugin, Object.freeze(fixture))
      },
      remove(plugin: string): void {
        claims.delete(plugin)
      },
    }),
    apply(rows: readonly EntryRow[]) {
      return tree.apply(rows)
    },
  })
}
