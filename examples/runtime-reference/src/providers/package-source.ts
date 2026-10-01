import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeWireTypes } from '@agnes/protocol/runtime'
import {
  acceptWire,
  contentProvenance,
  digestDirectory,
  digestMembers,
  emptyShelf,
  inlineRef,
  type MemoryPackage,
  type PackageIdentity,
  packageEntry,
  type ReferenceOutcome,
  readShelf,
  refuse,
  type Shelf,
  type ShelfRow,
  sha256,
  writeShelf,
} from './local-tree.js'

const SOURCE_CONTRACT = 'agh.package-source' as const
const DEFAULT_ID = 'agh.reference/package-source'

export interface ReferenceSourceOptions {
  readonly providerId?: string
  readonly cacheDir: string
  readonly localRoots?: Readonly<Record<string, string>>
  readonly memory?: Readonly<Record<string, readonly MemoryPackage[]>>
  readonly npmRegistries?: Readonly<Record<string, string>>
  readonly gitRepositories?: Readonly<Record<string, string>>
  readonly allowedFeatures?: readonly string[]
  readonly allowedScopes?: readonly string[]
  readonly transport?: unknown
  readonly git?: unknown
  readonly stageByteLimit?: number | null
}

interface Requirement {
  readonly packageId: string
  readonly versionRange: string
  readonly sourceIds: readonly string[]
}

function hasOwn(record: object, key: string): boolean {
  return Object.hasOwn(record, key)
}

function wanted(
  requirements: readonly Requirement[],
  sourceId: string,
  packageId: string,
  version: string,
): boolean {
  return requirements.some(
    (item) =>
      item.packageId === packageId &&
      item.versionRange === version &&
      (item.sourceIds.length === 0 || item.sourceIds.includes(sourceId)),
  )
}

function rowFrom(identity: PackageIdentity, sourceId: string): ShelfRow {
  return {
    packageId: identity.packageId,
    version: identity.version,
    treeDigest: identity.treeDigest,
    manifestDigest: identity.manifestDigest,
    sourceId,
    pathRef: `${identity.packageId}@${identity.version}`,
    manifest: identity.manifest,
  }
}

export function createPackageSourceProvider(options: ReferenceSourceOptions) {
  const providerId = options.providerId ?? DEFAULT_ID
  const localRoots = options.localRoots ?? {}
  const memory = options.memory ?? {}
  const npmRegistries = options.npmRegistries ?? {}
  const gitRepositories = options.gitRepositories ?? {}
  const loaded = readShelf(options.cacheDir)
  let shelf: Shelf = loaded.ok ? loaded.value : emptyShelf()
  if (!loaded.ok) writeShelf(options.cacheDir, shelf)
  let disposed = false
  let cancelled = false
  const networkReads = 0
  const reads = (): number => networkReads

  const gate = (): ReferenceOutcome<null> => {
    if (disposed) return refuse('internal', 'provider_disposed', 'reference package source is disposed')
    if (cancelled) return refuse('cancelled', 'operation_cancelled', 'reference package source is cancelled')
    return { ok: true, value: null }
  }

  const unsupported = (): ReferenceOutcome<never> =>
    refuse(
      'denied',
      'source_kind_unsupported',
      'reference package source reads local directories and memory fixtures only',
    )

  const save = (next: Shelf): void => {
    shelf = next
    writeShelf(options.cacheDir, next)
  }

  const admitIdentity = (
    identity: ReferenceOutcome<PackageIdentity>,
    sourceId: string,
    packageId: string,
    version: string,
    admitted: ShelfRow[],
    diagnostics: string[],
  ): void => {
    if (!identity.ok) {
      diagnostics.push(`${identity.detailCode}:${packageId}`.slice(0, 256))
      return
    }
    if (identity.value.packageId !== packageId || identity.value.version !== version) {
      diagnostics.push(`identity_mismatch:${packageId}`.slice(0, 256))
      return
    }
    admitted.push(rowFrom(identity.value, sourceId))
    writeOwned(identity.value.treeDigest, 'archive.tar', identity.value.payload)
    const partial = join(options.cacheDir, 'staging', identity.value.treeDigest, 'PARTIAL')
    if (existsSync(partial)) rmSync(partial)
  }

  function writeOwned(digest: string, name: string, bytes: Buffer): void {
    const dir = join(options.cacheDir, 'staging', digest)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'OWNER'), providerId)
    writeFileSync(join(dir, name), bytes)
  }

  function readIdentity(sourceId: string, pathRef: string): ReferenceOutcome<PackageIdentity> {
    const separator = pathRef.lastIndexOf('@')
    if (separator <= 0)
      return refuse('invalid_input', 'schema_invalid', 'local package path is missing a version')
    const packageId = pathRef.slice(0, separator)
    const version = pathRef.slice(separator + 1)
    const fixtures = memory[sourceId]
    if (fixtures !== undefined) {
      const fixture = fixtures.find((item) => item.packageId === packageId && item.version === version)
      if (fixture === undefined)
        return refuse('denied', 'source_unavailable', 'memory fixture is not present')
      return digestMembers(fixture.members)
    }
    const root = localRoots[sourceId]
    if (root === undefined) return refuse('denied', 'source_not_allowed', 'local source is not configured')
    return digestDirectory(join(root, packageId, version))
  }

  function stage(identity: PackageIdentity): ReferenceOutcome<RuntimeWireTypes['PackageSourceFetchResult']> {
    const limit = options.stageByteLimit
    const dir = join(options.cacheDir, 'staging', identity.treeDigest)
    if (typeof limit === 'number' && identity.payload.length > limit) {
      writeOwned(identity.treeDigest, 'PARTIAL', identity.payload.subarray(0, limit))
      return refuse(
        'cancelled',
        'operation_cancelled',
        'package fetch stopped before the local payload was stored',
      )
    }
    const archive = join(dir, 'archive.tar')
    if (!existsSync(archive)) {
      writeOwned(identity.treeDigest, 'archive.tar', identity.payload)
      const partial = join(dir, 'PARTIAL')
      if (existsSync(partial)) rmSync(partial)
    }
    const staged = acceptWire('DataRef', {
      kind: 'blob',
      schema: { typeId: 'agh.package/archive@1', revision: 1, digest: sha256('agh.package/archive@1') },
      blob: {
        authorityId: providerId,
        blobId: `stage:${identity.packageId}`.slice(0, 256),
        digest: sha256(identity.payload),
        bytes: identity.payload.length,
        mediaType: 'application/vnd.agnes.package-records+json',
        pinId: sha256(identity.payload),
      },
    })
    if (!staged.ok) return staged
    return acceptWire('PackageSourceFetchResult', {
      stagedPackageRef: staged.value,
      verifiedDigest: identity.treeDigest,
    })
  }

  return {
    providerId,
    contract: SOURCE_CONTRACT,
    networkReads: reads,
    processSpawns: (): number => 0,
    executedEntries: (): readonly string[] => [],
    discover(input: unknown): ReferenceOutcome<RuntimeWireTypes['PackageSourceDiscoverResult']> {
      const open = gate()
      if (!open.ok) return open
      const request = acceptWire('PackageSourceDiscoverRequest', input)
      if (!request.ok) return request
      const before = networkReads
      const ranked = shelf.rows
        .filter((row) => request.value.query === '' || row.packageId.includes(request.value.query))
        .slice()
        .sort(
          (left, right) =>
            comparePath(left.pathRef, right.pathRef) || comparePath(left.treeDigest, right.treeDigest),
        )
      const cursor = request.value.cursor
      const offset = cursor === null || cursor === '' ? 0 : Number(cursor)
      if (!Number.isInteger(offset) || offset < 0) {
        return refuse('invalid_input', 'schema_invalid', 'discover cursor is not an offset')
      }
      const items = []
      for (const row of ranked.slice(offset, offset + request.value.limit)) {
        const entry = packageEntry(row)
        if (!entry.ok) return entry
        items.push(entry.value)
      }
      if (networkReads !== before) {
        return refuse(
          'denied',
          'network_not_authorized',
          'discover read a source outside the authorized cache',
        )
      }
      const next = offset + items.length
      return acceptWire('PackageSourceDiscoverResult', {
        items,
        snapshot: shelf.snapshotId,
        nextCursor: next < ranked.length ? String(next) : null,
        complete: next >= ranked.length,
      })
    },
    resolveMetadata(
      input: unknown,
    ): ReferenceOutcome<RuntimeWireTypes['PackageSourceResolveMetadataResult']> {
      const open = gate()
      if (!open.ok) return open
      const request = acceptWire('PackageSourceResolveMetadataRequest', input)
      if (!request.ok) return request
      const found = shelf.rows.filter(
        (row) => row.packageId === request.value.packageId && row.version === request.value.version,
      )
      const digests = new Set(found.map((row) => row.treeDigest))
      if (digests.size > 1) {
        return refuse(
          'conflict',
          'content_identity_mismatch',
          'one package version has more than one tree digest',
        )
      }
      const row = found[0]
      if (row === undefined)
        return refuse('denied', 'cache_miss', 'package metadata is not in the authorized cache')
      const manifestRef = inlineRef('agh.package/manifest@1', row.manifest)
      if (!manifestRef.ok) return manifestRef
      return acceptWire('PackageSourceResolveMetadataResult', {
        manifestRef: manifestRef.value,
        digest: row.treeDigest,
        provenance: contentProvenance(providerId, row.sourceId),
      })
    },
    async fetch(input: unknown): Promise<ReferenceOutcome<RuntimeWireTypes['PackageSourceFetchResult']>> {
      const open = gate()
      if (!open.ok) return open
      const request = acceptWire('PackageSourceFetchRequest', input)
      if (!request.ok) return request
      const locator = request.value.locator
      if (locator.digest !== request.value.expectedDigest) {
        return refuse('denied', 'digest_mismatch', 'locator digest does not match the requested digest')
      }
      if (locator.kind !== 'local') return unsupported()
      const identity = readIdentity(locator.sourceId, locator.pathRef)
      if (!identity.ok) return identity
      if (identity.value.treeDigest !== request.value.expectedDigest) {
        return refuse('denied', 'digest_mismatch', 'package tree digest does not match the requested digest')
      }
      return stage(identity.value)
    },
    async refreshCatalog(
      input: unknown,
    ): Promise<ReferenceOutcome<RuntimeWireTypes['PackageSourceRefreshCatalogResult']>> {
      const open = gate()
      if (!open.ok) return open
      const request = acceptWire('PackageSourceRefreshCatalogRequest', input)
      if (!request.ok) return request
      const sourceId = request.value.sourceId
      if (hasOwn(npmRegistries, sourceId) || hasOwn(gitRepositories, sourceId)) return unsupported()
      const requirements = request.value.requirements
      const diagnostics: string[] = []
      const admitted: ShelfRow[] = []
      if (hasOwn(memory, sourceId)) {
        for (const fixture of memory[sourceId] ?? []) {
          if (!wanted(requirements, sourceId, fixture.packageId, fixture.version)) continue
          admitIdentity(
            digestMembers(fixture.members),
            sourceId,
            fixture.packageId,
            fixture.version,
            admitted,
            diagnostics,
          )
        }
      } else if (hasOwn(localRoots, sourceId)) {
        const root = localRoots[sourceId] ?? ''
        let packageNames: string[] = []
        try {
          packageNames = readdirSync(root)
        } catch {
          diagnostics.push('source-unavailable')
        }
        for (const packageId of packageNames) {
          let versions: string[] = []
          try {
            versions = readdirSync(join(root, packageId))
          } catch {
            continue
          }
          for (const version of versions) {
            if (!wanted(requirements, sourceId, packageId, version)) continue
            admitIdentity(
              digestDirectory(join(root, packageId, version)),
              sourceId,
              packageId,
              version,
              admitted,
              diagnostics,
            )
          }
        }
      } else {
        return refuse('denied', 'source_not_allowed', 'package source is not configured')
      }
      const revision = shelf.revision + 1
      const next: Shelf = {
        revision,
        snapshotId: `snapshot-${revision}`,
        rows: [...shelf.rows.filter((row) => row.sourceId !== sourceId), ...admitted],
      }
      save(next)
      const candidateRefs = []
      for (const row of admitted) {
        const ref = inlineRef('agh.package/candidate@1', {
          manifestDigest: row.manifestDigest,
          packageId: row.packageId,
          treeDigest: row.treeDigest,
          version: row.version,
        })
        if (!ref.ok) return ref
        candidateRefs.push(ref.value)
      }
      return acceptWire('PackageSourceRefreshCatalogResult', {
        catalogRevision: revision,
        candidateRefs,
        diagnosticIds: diagnostics,
      })
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

function comparePath(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}
