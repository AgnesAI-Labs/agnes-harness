import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Outcome } from '@agnes/extension-api/runtime'
import {
  type BuildIdentity,
  type ConformanceHarness,
  providerFileForContract,
} from '@agnes/extension-api/testkit'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import {
  registerAuthorityTransferContract,
  TRANSFER_MAINTAINER,
  type TransferContractPort,
  type TransferStore,
  type TransferSubject,
  transferContractPort,
} from '../../../../packages/extension-api/testkit/runtime/contracts/authority-transfer.js'
import {
  BLOB_READER,
  type BlobContractPort,
  blobContractPort,
  CONFORMANCE_SCOPE,
  callContext,
  content,
  createBlobReadGate,
  rangeFact,
  registerBlobContract,
  same,
  streamed,
  streamFact,
} from '../../../../packages/extension-api/testkit/runtime/contracts/blob.js'
import { BLOB_PROVIDER, type BlobStore, type BlobStoreOptions, openBlobStore, PIECE_BYTES } from './blob.js'
import { referenceDescriptor, type TransferMaintenance } from './blob-transfer.js'

const sha256 = (url: URL) => createHash('sha256').update(readFileSync(url)).digest('hex')

export const build: BuildIdentity = {
  codeSha: 'reference-code',
  buildDigest: 'reference-build',
  lockDigest: 'reference-lock',
  specVersion: 'reference-spec',
  sdkVersion: 'reference-sdk',
  sdkDigest: 'reference-sdk-digest',
  platform: 'reference-platform',
}

export const releaseSetDigest = () => sha256(new URL('../../package.json', import.meta.url))

/**
 * Overwrites the stored pieces of one object behind the store's back. The recorded piece digests stay,
 * and pieces past the new length are dropped, as a damaged or truncated backend would leave them.
 */
export function damage(databasePath: string, blobId: string, bytes: Uint8Array): void {
  const db = new DatabaseSync(databasePath)
  try {
    db.prepare('DELETE FROM pieces WHERE blob_id = ? AND seq * ? >= ?').run(
      blobId,
      PIECE_BYTES,
      bytes.byteLength,
    )
    const update = db.prepare('UPDATE pieces SET data = ? WHERE blob_id = ? AND seq = ?')
    for (let seq = 0; seq * PIECE_BYTES < bytes.byteLength; seq++)
      update.run(bytes.subarray(seq * PIECE_BYTES, (seq + 1) * PIECE_BYTES), blobId, seq)
  } finally {
    db.close()
  }
}

/** Drives the reference blob store through the six scenarios; the contract module judges what it reports. */
export function referenceBlobPort(
  databasePath: string,
  providerId: string = BLOB_PROVIDER.id,
): { port: BlobContractPort; close(): void } {
  const gate = createBlobReadGate()
  const options = { authorizeRead: gate.allows }
  let current = openBlobStore(databasePath, options)
  const port = blobContractPort({
    binding: {
      requirement: {
        contract: 'agh.blob',
        major: 1,
        logicalName: `blob-${providerId}`,
        features: [...current.features],
        scope: 'runtime',
        optional: false,
      },
      binding: {
        bindingId: `reference-blob-${providerId}`,
        contract: 'agh.blob',
        logicalName: `blob-${providerId}`,
        providerId,
      },
      blobRead: current.blobRead,
    },
    gate,
    read: () => current.blobRead,
    seed: async (bytes) => current.seed(bytes),
    corrupt: async (ref, bytes) => damage(databasePath, ref.blobId, bytes),
    async reopen() {
      current.close()
      current = openBlobStore(databasePath, options)
    },
    close: async () => current.close(),
    remains: () => existsSync(databasePath),
  })
  return { port, close: () => current.close() }
}

const AUTHORITY = 'reference-blob'
export const TENANT = 'reference-tenant'
export const SOURCE = 'reference-source'
/** Small parts, so a seeded world exports many and its manifest is paged through cursors. */
const EXPORT_PART = { records: 2, bytes: 4 * PIECE_BYTES }

type Seeded = { live: [Wire.BlobRef, Uint8Array][]; deleted: Wire.BlobRef[] }

function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.value
}

/** Seeds live, owned, released and collected content through the store's own write paths. */
async function seed(store: BlobStore): Promise<Seeded> {
  const context = callContext('transfer-principal', BLOB_READER)
  const live: Seeded['live'] = [content(PIECE_BYTES + 5, 21), content(100, 22)].map((bytes) => [
    store.seed(bytes),
    bytes,
  ])
  const owned = content(300, 23)
  const upload = store.upload(owned)
  const stagedBlob = must(await store.promote({ upload, expectedDigest: upload.digest }, context))
  const ownerRef = { kind: 'artifact', value: { artifactId: 'reference-artifact', version: 1 } } as const
  live.push([must(await store.pin({ stagedBlob, ownerRef, retentionUntil: null }, context)), owned])
  const deleted = [store.seed(content(7, 24)), store.seed(content(9, 25))]
  for (const ref of deleted) must(await store.unpin({ pinId: ref.pinId, expectedRevision: 1 }, context))
  must(await store.gc({ scopeRef: CONFORMANCE_SCOPE, dryRun: false, cursor: null, limit: 100 }, context))
  return { live, deleted }
}

/** One reference store as the transfer suite drives it, over one database path. */
function transferStore(path: string, options: BlobStoreOptions, seeded: Seeded) {
  let current = openBlobStore(path, options)
  const reader = callContext('transfer-principal', BLOB_READER)
  return {
    current: () => current,
    control: () => current.transfer,
    async write() {
      try {
        current.seed(content(16, 41))
        return null
      } catch (caught) {
        return (caught as { error?: Wire.RuntimeError }).error?.detailCode ?? 'thrown'
      }
    },
    async serves() {
      for (const [ref, bytes] of seeded.live) {
        const fact = await streamFact(() => current.blobRead.openRead({ ref, offset: 0 }, reader))
        if (!streamed(fact, bytes, 0)) return false
      }
      for (const ref of seeded.deleted) {
        const fact = await rangeFact(() => current.blobRead.readRange({ ref, offset: 0, length: 1 }, reader))
        if (!same(fact, { refused: 'artifact_deleted' })) return false
      }
      return true
    },
    async reopen() {
      current.close()
      current = openBlobStore(path, options)
    },
    close: async () => current.close(),
  } satisfies TransferStore & { current(): BlobStore }
}

export type Routes = Map<string, { route: Wire.AuthorityRoute; targetActivated: boolean }>

/**
 * The maintenance assembly of a reference store at `locationRef`, over `routes` standing in for the
 * directory's published routes; an import reads the source's exported bytes through `readSource`.
 */
export function directoryMaintenance(
  routes: Routes,
  locationRef: string,
  readSource: TransferMaintenance['readSource'],
  plan: string,
): TransferMaintenance {
  return {
    authorize: (context) => context.authorizationRef === TRANSFER_MAINTAINER,
    tenantId: TENANT,
    locationRef,
    readRoute: async ({ logicalAuthorityId }) => {
      const held = routes.get(logicalAuthorityId)
      if (held) return { ok: true, value: held }
      const message = 'the directory holds no route for this authority'
      return {
        ok: false,
        error: {
          code: 'invalid_input',
          detailCode: 'not_found',
          message,
          retryAdvice: { kind: 'never' },
          diagnosticId: 'reference-directory',
        },
      }
    },
    readSource,
    planFingerprint: canonicalJsonDigest(plan),
  }
}

/**
 * Reference worlds for the transfer suite: a seeded source and candidate targets as databases in one
 * temporary directory, with an in-memory maintenance directory standing in for the published routes.
 */
function referenceTransferSubject(providerId: string, packageDigest: string): TransferSubject {
  const binding: Wire.BindingRef = {
    bindingId: `reference-blob-${providerId}`,
    contract: 'agh.blob',
    logicalName: `blob-${providerId}`,
    providerId,
  }
  return {
    async open(maintained) {
      const directory = mkdtempSync(join(tmpdir(), 'reference-blob-transfer-'))
      const routes: Routes = new Map()
      const stores = new Map<string, ReturnType<typeof transferStore>>()
      const seeded: Seeded = { live: [], deleted: [] }
      let cut: number | null = null
      const pathOf = (locationRef: string) => {
        if (!/^[a-z0-9-]+$/.test(locationRef)) throw new Error('location is not a plain name')
        return join(directory, `${locationRef}.sqlite`)
      }
      const maintenance = (locationRef: string) =>
        directoryMaintenance(
          routes,
          locationRef,
          async function* (ref, context) {
            if (cut === 0) throw new Error('the source is unreachable')
            if (cut !== null) cut -= 1
            yield* source.current().readExport(ref, context)
          },
          'reference-blob-transfer-plan',
        )
      const options = (locationRef: string, candidate: boolean): BlobStoreOptions => ({
        authorityId: AUTHORITY,
        authorizeRead: (context) => context.authorizationRef === BLOB_READER,
        candidate,
        exportPart: EXPORT_PART,
        ...(maintained ? { maintenance: maintenance(locationRef) } : {}),
      })
      const source = transferStore(pathOf(SOURCE), options(SOURCE, false), seeded)
      stores.set(SOURCE, source)
      Object.assign(seeded, await seed(source.current()))
      const behind = (locationRef: string, change: (db: DatabaseSync) => void) => {
        const db = new DatabaseSync(pathOf(locationRef))
        try {
          change(db)
        } finally {
          db.close()
        }
      }
      return {
        descriptor: referenceDescriptor(binding, source.current().features, packageDigest, {
          omitted: ['stage'],
          requires: [],
        }),
        source,
        authority: { authorityId: AUTHORITY, tenantId: TENANT, authorityEpoch: 1 },
        locationRef: SOURCE,
        providerBinding: binding,
        async target(locationRef) {
          const store =
            stores.get(locationRef) ?? transferStore(pathOf(locationRef), options(locationRef, true), seeded)
          stores.set(locationRef, store)
          return store
        },
        publish: (route, targetActivated) =>
          void routes.set(route.logicalAuthorityId, { route, targetActivated }),
        cut: (after) => {
          cut = after
        },
        // One hex character of a recorded digest changes: the chunk still parses, only its digest tells.
        tamper: async (chunk) =>
          behind(SOURCE, (db) => {
            const row = db.prepare('SELECT data FROM transfer_bytes WHERE digest = ?').get(chunk.digest) as {
              data: Uint8Array
            }
            const data = Buffer.from(row.data)
            const at = data.indexOf('"digest":"') + '"digest":"'.length
            data[at] = data[at] === 0x30 ? 0x31 : 0x30
            db.prepare('UPDATE transfer_bytes SET data = ? WHERE digest = ?').run(data, chunk.digest)
          }),
        damage: async (locationRef) =>
          behind(locationRef, (db) => db.exec("UPDATE objects SET media_type = 'application/x-damaged'")),
        async dispose() {
          for (const store of stores.values()) await store.close()
          rmSync(directory, { recursive: true, force: true })
        },
      }
    },
  }
}

/**
 * Registers the six blob cases and the six authority transfer cases for the reference provider on
 * fresh databases, reported under `providerId` (the runner passes the name it was asked for, such as
 * `reference`). `change` and `changeTransfer` let a test break one scenario to prove the contract
 * notices. Call `close` after the harness has run.
 */
export function bindBlobContract(
  harness: ConformanceHarness,
  command: string,
  options: Readonly<{
    providerId?: string
    change?: (port: BlobContractPort) => BlobContractPort
    changeTransfer?: (port: TransferContractPort) => TransferContractPort
  }> = {},
): { close(): void } {
  const providerId = options.providerId ?? BLOB_PROVIDER.id
  const directory = mkdtempSync(join(tmpdir(), 'reference-blob-contract-'))
  const reference = referenceBlobPort(join(directory, 'blob.sqlite'), providerId)
  const recipe = providerFileForContract('agh.blob')
  const providerDigest = sha256(new URL('./blob.ts', import.meta.url))
  registerBlobContract(harness, {
    providerId,
    recipe,
    command,
    build,
    providerDigest,
    configDigest: canonicalJsonDigest({ pieceBytes: PIECE_BYTES }),
    releaseSetDigest: releaseSetDigest(),
    port: options.change ? options.change(reference.port) : reference.port,
  })
  const transferDigest = canonicalJsonDigest([
    providerDigest,
    sha256(new URL('./blob-transfer.ts', import.meta.url)),
  ])
  const transfer = transferContractPort(referenceTransferSubject(providerId, transferDigest))
  registerAuthorityTransferContract(harness, 'agh.blob', {
    providerId,
    recipe,
    command,
    build,
    providerDigest: transferDigest,
    configDigest: canonicalJsonDigest({ pieceBytes: PIECE_BYTES, exportPart: EXPORT_PART }),
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
