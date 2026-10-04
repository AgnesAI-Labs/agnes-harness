import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BlobReadPort, CallContext, Outcome } from '@agnes/extension-api/runtime'
import {
  type ConformanceHarness,
  createTestServiceContainer,
  providerFileForContract,
} from '@agnes/extension-api/testkit'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import {
  ARTIFACT_READER,
  type ArtifactsContractPort,
  artifactsContractPort,
  registerArtifactsContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/artifacts.js'
import {
  registerAuthorityTransferContract,
  TRANSFER_MAINTAINER,
  type TransferContractPort,
  type TransferStore,
  type TransferSubject,
  transferContractPort,
} from '../../../../packages/extension-api/testkit/runtime/contracts/authority-transfer.js'
import {
  callContext,
  content,
  rangeFact,
  same,
  streamed,
  streamFact,
} from '../../../../packages/extension-api/testkit/runtime/contracts/blob.js'
import { inline } from '../../../../packages/extension-api/testkit/runtime/contracts/projection.js'
import { ARTIFACTS_PROVIDER, type ArtifactsStore, BLOB_DEPENDENCY, openArtifactsStore } from './artifacts.js'
import { BLOB_PROVIDER, type BlobStore, openBlobStore } from './blob.js'
import {
  build,
  directoryMaintenance,
  type Routes,
  releaseSetDigest,
  SOURCE,
  TENANT,
} from './blob-contract.js'
import { referenceDescriptor } from './blob-transfer.js'

/** A profile lifetime narrower than the contract's, so the suite sees the provider take the smaller one. */
export const PROFILE_TICKET_TTL_MS = 120_000
const TICKET_KEY = new Uint8Array(32).fill(9)
const MEDIA_TYPE = 'application/octet-stream'

const sha256 = (url: URL) => createHash('sha256').update(readFileSync(url)).digest('hex')
const readable = (context: CallContext) => context.authorizationRef === ARTIFACT_READER.authorizationRef

/**
 * Drives the reference artifacts store, reading through the reference blob store selected in a test
 * service container, through the six scenarios; the contract module judges what it reports.
 */
export function referenceArtifactsPort(
  directory: string,
  providerId: string = ARTIFACTS_PROVIDER.id,
): { port: ArtifactsContractPort; close(): void } {
  const blobPath = join(directory, 'blob.sqlite')
  const artifactsPath = join(directory, 'artifacts.sqlite')
  let clock = Date.parse('2026-10-01T00:00:00.000Z')
  let reads = 0
  const openBlob = () => openBlobStore(blobPath, { authorizeRead: readable })
  let blob = openBlob()
  const counted: BlobReadPort = {
    readRange: (request, context) => {
      reads += 1
      return blob.blobRead.readRange(request, context)
    },
    openRead: (request, context) => {
      reads += 1
      return blob.blobRead.openRead(request, context)
    },
  }
  const container = createTestServiceContainer()
  container.register({
    requirement: BLOB_DEPENDENCY,
    binding: {
      bindingId: 'reference-blob',
      contract: 'agh.blob',
      logicalName: BLOB_DEPENDENCY.logicalName,
      providerId: BLOB_PROVIDER.id,
    },
    blobRead: counted,
  })
  const openArtifacts = () =>
    openArtifactsStore(artifactsPath, {
      dependencies: container.dependencies,
      authorize: readable,
      ticketKey: TICKET_KEY,
      ticketTtlMs: PROFILE_TICKET_TTL_MS,
      now: () => clock,
    })
  let artifacts = openArtifacts()
  const grants = new Map<string, Wire.Id>()
  const key = (ref: Wire.ArtifactRef) => `${ref.artifactId}@${ref.version}`
  const close = () => {
    artifacts.close()
    blob.close()
  }
  const port = artifactsContractPort({
    binding: {
      requirement: {
        contract: 'agh.artifacts',
        major: 1,
        logicalName: `artifacts-${providerId}`,
        features: ['artifact-access.v1'],
        scope: 'runtime',
        optional: false,
      },
      binding: {
        bindingId: `reference-artifacts-${providerId}`,
        contract: 'agh.artifacts',
        logicalName: `artifacts-${providerId}`,
        providerId,
      },
      artifactAccess: artifacts.artifactAccess,
    },
    access: () => artifacts.artifactAccess,
    async publish(bytes, artifactId) {
      const ref = artifacts.publishPinned({
        artifactId: artifactId ?? null,
        blob: blob.seed(bytes, MEDIA_TYPE),
        title: 'Conformance',
        mediaType: MEDIA_TYPE,
      })
      const grant = artifacts.grant({
        artifact: ref,
        granteePrincipalRef: ARTIFACT_READER.principalRef,
        scope: ARTIFACT_READER.scope,
        permissions: ['read', 'download'],
        sourceAuthorizationRef: 'conformance-policy',
      })
      grants.set(key(ref), grant.grantId)
      return ref
    },
    revoke: async (ref) => artifacts.revoke(ref),
    async revokeGrant(ref) {
      artifacts.revokeGrant(grants.get(key(ref)) ?? 'missing')
    },
    now: () => clock,
    advance(ms) {
      clock += ms
    },
    blobReads: () => reads,
    async reopen() {
      close()
      blob = openBlob()
      artifacts = openArtifacts()
    },
    close: async () => close(),
    remains: () => existsSync(blobPath) && existsSync(artifactsPath),
    locations: [directory, realpathSync(directory)],
    ticketTtlMs: PROFILE_TICKET_TTL_MS,
  })
  return { port, close }
}

const AUTHORITY = 'reference-artifacts'
const BLOB_AUTHORITY = 'reference-blob'
const BLOB_UPGRADE = 'reference-blob-cohort'
const COHORT = canonicalJsonDigest('reference-artifacts-cohort')
/** Small parts, so a seeded world exports several and its manifest is paged through cursors. */
const EXPORT_PART = { records: 2, bytes: 1024 * 1024 }
const BLOB_BINDING: Wire.BindingRef = {
  bindingId: 'reference-blob',
  contract: 'agh.blob',
  logicalName: BLOB_DEPENDENCY.logicalName,
  providerId: BLOB_PROVIDER.id,
}
const ROUTE = { typeId: 'agh.reference/authority-route@1', revision: 1, digest: canonicalJsonDigest('route') }

type Cohort = { blob: BlobStore; artifacts: ArtifactsStore }
type Seeded = {
  live: { ref: Wire.ArtifactRef; bytes: Uint8Array; blob: Wire.BlobRef }[]
  /** Versions that must stay unreadable, with the refusal a read gets. */
  gone: [Wire.ArtifactRef, string][]
}

function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.value
}

/** Seeds two live versions, a revoked version and one whose only grant was revoked. */
function seedArtifacts({ blob, artifacts }: Cohort): Seeded {
  const publish = (salt: number, artifactId: Wire.Id | null = null) => {
    const bytes = content(64 + salt, salt)
    const pinned = blob.seed(bytes, MEDIA_TYPE)
    const ref = artifacts.publishPinned({
      artifactId,
      blob: pinned,
      title: 'Transfer',
      mediaType: MEDIA_TYPE,
    })
    const grant = artifacts.grant({
      artifact: ref,
      granteePrincipalRef: ARTIFACT_READER.principalRef,
      scope: ARTIFACT_READER.scope,
      permissions: ['read'],
      sourceAuthorizationRef: 'transfer-policy',
    })
    return { ref, bytes, blob: pinned, grant }
  }
  const first = publish(31)
  const second = publish(32, first.ref.artifactId)
  const revoked = publish(33)
  const ungranted = publish(34)
  artifacts.revoke(revoked.ref)
  artifacts.revokeGrant(ungranted.grant.grantId, 'transfer-revoke')
  return {
    live: [first, second],
    gone: [
      [revoked.ref, 'revoked'],
      [ungranted.ref, 'permission_denied'],
    ],
  }
}

/** One location's blob and artifacts stores, as the transfer suite drives the artifacts one. */
function cohortStore(open: () => Cohort, seeded: Seeded) {
  let current = open()
  const reader = callContext(ARTIFACT_READER.principalRef, ARTIFACT_READER.authorizationRef)
  const close = async () => {
    current.artifacts.close()
    current.blob.close()
  }
  return {
    current: () => current,
    control: () => current.artifacts.transfer,
    /** Publishes a version over content the blob store already holds, so only the artifacts store writes. */
    async write() {
      const blob = seeded.live[0]?.blob
      if (!blob) throw new Error('the world was not seeded')
      try {
        current.artifacts.publishPinned({ artifactId: null, blob, title: 'Write', mediaType: MEDIA_TYPE })
        return null
      } catch (caught) {
        return (caught as { error?: Wire.RuntimeError }).error?.detailCode ?? 'thrown'
      }
    },
    async serves() {
      const access = current.artifacts.artifactAccess
      for (const { ref, bytes } of seeded.live)
        if (!streamed(await streamFact(() => access.openStream(ref, reader)), bytes, 0)) return false
      for (const [ref, refused] of seeded.gone) {
        const fact = await rangeFact(() => access.readRange({ ...ref, offset: 0, length: 1 }, reader))
        if (!same(fact, { refused })) return false
      }
      return true
    },
    async reopen() {
      await close()
      current = open()
    },
    close,
  } satisfies TransferStore & { current(): Cohort }
}

/**
 * Reference artifacts worlds for the transfer suite, each location a blob store and an artifacts store
 * over it. A cohort moves the blob service first: a maintained world fences and exports the source's
 * blob store as it opens, and each target location's blob store imports and activates that export
 * before the suite drives the artifacts store there.
 */
function artifactsTransferSubject(providerId: string, packageDigest: string): TransferSubject {
  const binding: Wire.BindingRef = {
    bindingId: `reference-artifacts-${providerId}`,
    contract: 'agh.artifacts',
    logicalName: `artifacts-${providerId}`,
    providerId,
  }
  const control = callContext('transfer-principal', TRANSFER_MAINTAINER)
  return {
    async open(maintained) {
      const directory = mkdtempSync(join(tmpdir(), 'reference-artifacts-transfer-'))
      const routes: Routes = new Map()
      const blobRoutes: Routes = new Map()
      const stores = new Map<string, ReturnType<typeof cohortStore>>()
      const seeded: Seeded = { live: [], gone: [] }
      let cut: number | null = null
      const pathOf = (locationRef: string, kind: 'blob' | 'artifacts') => {
        if (!/^[a-z0-9-]+$/.test(locationRef)) throw new Error('location is not a plain name')
        return join(directory, `${locationRef}-${kind}.sqlite`)
      }
      const opening = (locationRef: string, candidate: boolean) => (): Cohort => {
        const blob = openBlobStore(pathOf(locationRef, 'blob'), {
          authorizeRead: readable,
          candidate,
          ...(maintained
            ? {
                maintenance: directoryMaintenance(
                  blobRoutes,
                  locationRef,
                  (ref, context) => source.current().blob.readExport(ref, context),
                  'reference-blob-transfer-plan',
                ),
              }
            : {}),
        })
        const container = createTestServiceContainer()
        container.register({ requirement: BLOB_DEPENDENCY, binding: BLOB_BINDING, blobRead: blob.blobRead })
        const artifacts = openArtifactsStore(pathOf(locationRef, 'artifacts'), {
          dependencies: container.dependencies,
          authorize: readable,
          authorityId: AUTHORITY,
          candidate,
          exportPart: EXPORT_PART,
          ...(maintained
            ? {
                maintenance: directoryMaintenance(
                  routes,
                  locationRef,
                  async function* (ref, context) {
                    if (cut === 0) throw new Error('the source is unreachable')
                    if (cut !== null) cut -= 1
                    yield* source.current().artifacts.readExport(ref, context)
                  },
                  'reference-artifacts-transfer-plan',
                ),
                blobTransfer: { binding: BLOB_BINDING, holds: (ref) => blob.holds(ref) },
              }
            : {}),
        })
        return { blob, artifacts }
      }
      const source = cohortStore(opening(SOURCE, false), seeded)
      stores.set(SOURCE, source)
      Object.assign(seeded, seedArtifacts(source.current()))
      const sourceBlob = source.current().blob.transfer
      const blobExport = maintained
        ? must(
            await sourceBlob.export(
              {
                upgradeId: BLOB_UPGRADE,
                fenceId: must(
                  await sourceBlob.fence(
                    {
                      upgradeId: BLOB_UPGRADE,
                      expected: { authorityId: BLOB_AUTHORITY, tenantId: TENANT, authorityEpoch: 1 },
                      cohortDigest: COHORT,
                    },
                    control,
                  ),
                ).fenceId,
              },
              control,
            ),
          )
        : undefined
      /** Imports the blob export at `locationRef` and activates it on the route the directory publishes. */
      async function moveBlobs(blob: BlobStore, exported: Wire.AuthorityExport, locationRef: string) {
        const imported = must(
          await blob.transfer.import(
            { upgradeId: BLOB_UPGRADE, source: exported, targetLocationRef: locationRef },
            control,
          ),
        )
        const authorityEpoch = exported.checkpoint.authorityEpoch + 1
        const route: Wire.AuthorityRoute = {
          logicalAuthorityId: BLOB_AUTHORITY,
          tenantId: TENANT,
          authorityEpoch,
          providerBinding: BLOB_BINDING,
          locationRef,
          cohortDigest: COHORT,
          cutoverId: `blob-${locationRef}`,
          checkpoint: { ...imported.targetCheckpoint, authorityEpoch },
          previous: { authorityEpoch: authorityEpoch - 1, locationRef: SOURCE, cutoverId: 'reference-none' },
        }
        blobRoutes.set(BLOB_AUTHORITY, { route, targetActivated: false })
        const publishedRoute = inline(ROUTE, route as unknown as Wire.JsonValue)
        must(
          await blob.transfer.activate(
            { upgradeId: BLOB_UPGRADE, cutoverId: route.cutoverId, publishedRoute },
            control,
          ),
        )
      }
      const behind = (locationRef: string, change: (db: DatabaseSync) => void) => {
        const db = new DatabaseSync(pathOf(locationRef, 'artifacts'))
        try {
          change(db)
        } finally {
          db.close()
        }
      }
      return {
        descriptor: referenceDescriptor(binding, source.current().artifacts.features, packageDigest, {
          omitted: ['revoke', 'query'],
          requires: [BLOB_DEPENDENCY],
        }),
        source,
        authority: { authorityId: AUTHORITY, tenantId: TENANT, authorityEpoch: 1 },
        locationRef: SOURCE,
        providerBinding: binding,
        async target(locationRef) {
          const known = stores.get(locationRef)
          if (known) return known
          const store = cohortStore(opening(locationRef, true), seeded)
          if (blobExport) await moveBlobs(store.current().blob, blobExport, locationRef)
          stores.set(locationRef, store)
          return store
        },
        publish: (route, targetActivated) =>
          void routes.set(route.logicalAuthorityId, { route, targetActivated }),
        cut: (after) => {
          cut = after
        },
        // One hex letter changes, so the chunk still parses and only its digest tells.
        tamper: async (chunk) =>
          behind(SOURCE, (db) => {
            const row = db.prepare('SELECT data FROM transfer_bytes WHERE digest = ?').get(chunk.digest) as {
              data: Uint8Array
            }
            const data = Buffer.from(row.data)
            const at = data.findIndex((byte) => byte >= 0x61 && byte <= 0x66)
            data[at] = data[at] === 0x61 ? 0x62 : 0x61
            db.prepare('UPDATE transfer_bytes SET data = ? WHERE digest = ?').run(data, chunk.digest)
          }),
        damage: async (locationRef) =>
          behind(locationRef, (db) => db.exec("UPDATE artifact_versions SET title = 'damaged'")),
        async dispose() {
          for (const store of stores.values()) await store.close()
          rmSync(directory, { recursive: true, force: true })
        },
      }
    },
  }
}

/**
 * Registers the six artifacts cases and the six authority transfer cases for the reference provider
 * on fresh databases, reported under `providerId`. `change` and `changeTransfer` let a test break one
 * scenario to prove the contract notices. Call `close` after the harness has run.
 */
export function bindArtifactsContract(
  harness: ConformanceHarness,
  command: string,
  options: Readonly<{
    providerId?: string
    change?: (port: ArtifactsContractPort) => ArtifactsContractPort
    changeTransfer?: (port: TransferContractPort) => TransferContractPort
  }> = {},
): { close(): void } {
  const providerId = options.providerId ?? ARTIFACTS_PROVIDER.id
  const directory = mkdtempSync(join(tmpdir(), 'reference-artifacts-contract-'))
  const reference = referenceArtifactsPort(directory, providerId)
  const recipe = providerFileForContract('agh.artifacts')
  const providerDigest = sha256(new URL('./artifacts.ts', import.meta.url))
  registerArtifactsContract(harness, {
    providerId,
    recipe,
    command,
    build,
    providerDigest,
    configDigest: canonicalJsonDigest({ ticketTtlMs: PROFILE_TICKET_TTL_MS }),
    releaseSetDigest: releaseSetDigest(),
    port: options.change ? options.change(reference.port) : reference.port,
  })
  const transferDigest = canonicalJsonDigest([
    providerDigest,
    sha256(new URL('./blob-transfer.ts', import.meta.url)),
  ])
  const transfer = transferContractPort(artifactsTransferSubject(providerId, transferDigest))
  registerAuthorityTransferContract(harness, 'agh.artifacts', {
    providerId,
    recipe,
    command,
    build,
    providerDigest: transferDigest,
    configDigest: canonicalJsonDigest({ exportPart: EXPORT_PART }),
    releaseSetDigest: releaseSetDigest(),
    port: options.changeTransfer ? options.changeTransfer(transfer) : transfer,
  })
  return {
    close() {
      reference.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
