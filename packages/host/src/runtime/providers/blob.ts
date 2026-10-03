import { createHash } from 'node:crypto'
import { constants, mkdirSync } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BlobReadPort,
  ByteRangeResult,
  ByteReadStream,
  CallContext,
  Outcome,
} from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import {
  RuntimeClientTransportPolicy,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { gc, inspect, pin, promote, resolvePin, unpin } from '../blob/retention.js'
import {
  BlobRefusal,
  type BlobStore,
  blobError,
  openBlobStore,
  openUploadWriter,
  parse,
  refuse,
  stage,
  type UploadWriter,
} from '../blob/uploads.js'

export const BLOB_CONTRACT = 'agh.blob'
export const BLOB_MAJOR = 1
export const BLOB_FEATURES = ['blob-read.v1'] as const

/**
 * The data directory of one default runtime service, `<hostDataDir>/runtime-services/<service>`,
 * created when missing. These services keep their content and databases under `<dataDir>/artifacts`,
 * which the legacy private artifact store already owns in the Host data directory, so callers
 * assembling them pass this directory as `dataDir`, never the Host data directory itself.
 */
export function runtimeServiceDataDir(hostDataDir: string, service: 'blob' | 'artifacts'): string {
  const dir = join(hostDataDir, 'runtime-services', service)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export type ServiceDescriptorInput = Readonly<{
  binding: Wire.BindingRef
  packageVersion: string
  packageDigest: string
  configSchema: Wire.SchemaRef
}>

/**
 * The validated descriptor of a default runtime service: one operation for each remote catalog method
 * whose required feature is declared; local port methods are not operations. Queries are read-only,
 * the `idempotent` actions return their first result again for the same input, and any other action
 * is never retried.
 */
export function defaultServiceDescriptor(
  contract: 'agh.blob' | 'agh.artifacts',
  input: ServiceDescriptorInput,
  features: readonly string[],
  requires: readonly Wire.ServiceRequirement[],
  idempotent: readonly string[],
): Wire.ProviderDescriptor {
  if (input.binding.contract !== contract) throw new Error(`invalid ${contract} binding`)
  const methods: Readonly<Record<string, { kind?: string; local?: boolean; requiredFeature?: string }>> =
    RuntimeServiceCatalog[contract].methods
  const schemas: Readonly<Partial<Record<string, { input: Wire.SchemaRef; output: Wire.SchemaRef }>>> =
    RuntimeMethodSchemaRefs[contract]
  const checked = validateRuntime('ProviderDescriptor', {
    providerId: input.binding.providerId,
    contract,
    major: RuntimeServiceCatalog[contract].major,
    logicalName: input.binding.logicalName,
    packageVersion: input.packageVersion,
    packageDigest: input.packageDigest,
    features,
    scope: 'runtime',
    configSchema: input.configSchema,
    requires,
    capabilities: [],
    recovery: 'R1',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: Object.entries(methods).flatMap(([method, { kind, local, requiredFeature }]) =>
      local || (requiredFeature && !features.includes(requiredFeature))
        ? []
        : [
            {
              method,
              kind,
              inputSchema: schemas[method]?.input,
              outputSchema: schemas[method]?.output,
              requiredCapabilities: [],
              retrySafety:
                kind === 'query' ? 'read-only' : idempotent.includes(method) ? 'idempotent' : 'never',
            },
          ],
    ),
  })
  if (!checked.ok) throw new Error(`invalid ${contract} descriptor`)
  return checked.value
}

/** Stage, promote and pin return their first result again; unpin reports `released` only once. */
export function blobProviderDescriptor(input: ServiceDescriptorInput): Wire.ProviderDescriptor {
  return defaultServiceDescriptor(BLOB_CONTRACT, input, BLOB_FEATURES, [], ['stage', 'promote', 'pin'])
}

const CHUNK_BYTES = RuntimeClientTransportPolicy.maxRangeBytes

export type BlobServiceOptions = Readonly<{
  dataDir: string
  authorityId: Wire.Id
  binding: Wire.BindingRef
  now?: () => number
  /**
   * The Host's check that a read call carries a trusted delegation. Production assembly does not
   * provide one yet, so without it every read is refused as blocked.
   */
  authorizeRead?: (context: CallContext, ref: Wire.BlobRef) => boolean
}>

type Handler<T> = (request: unknown, context: CallContext) => Promise<Outcome<T>>

/** The default agh.blob service: an upload and pin store on SQLite over the local content store. */
export type BlobService = Readonly<{
  binding: Wire.BindingRef
  stage: Handler<Wire.UploadSession>
  promote: Handler<Wire.StagedBlobRef>
  pin: Handler<Wire.BlobRef>
  unpin: Handler<Wire.BlobUnpinResult>
  gc: Handler<Wire.BlobGcResult>
  inspect: Handler<Wire.BlobInspectResult>
  blobRead: BlobReadPort
  /** Host-internal upload byte path; not an agh.blob method. */
  openWriter(uploadId: Wire.Id, context: CallContext): Outcome<UploadWriter>
  close(): void
}>

const errorOf = (caught: unknown): Wire.RuntimeError =>
  caught instanceof BlobRefusal ? caught.error : blobError('internal_error', 'blob service failed')

async function run<T>(context: CallContext, body: () => T | Promise<T>): Promise<Outcome<T>> {
  if (context.signal.aborted) return { ok: false, error: blobError('cancelled', 'call was cancelled') }
  try {
    return { ok: true, value: await body() }
  } catch (caught) {
    return { ok: false, error: errorOf(caught) }
  }
}

async function readExact(handle: FileHandle, position: number, length: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) refuse('integrity', 'blob bytes ended early')
    filled += bytesRead
  }
  return buffer
}

/** A pull stream: the next chunk is read only when the consumer asks, and every chunk rechecks access. */
function fileStream(
  handle: FileHandle,
  ref: Wire.BlobRef,
  offset: number,
  recheck: () => void,
): ByteReadStream {
  let settle: (outcome: Outcome<Wire.ArtifactReadStreamEndResult>) => void = () => undefined
  const ended = new Promise<Outcome<Wire.ArtifactReadStreamEndResult>>((resolve) => {
    settle = resolve
  })
  let finished = false
  const finish = (outcome: Outcome<Wire.ArtifactReadStreamEndResult>) => {
    if (finished) return
    finished = true
    settle(outcome)
    void handle.close().catch(() => undefined)
  }
  const stop = async () => finish({ ok: false, error: blobError('cancelled', 'stream was cancelled') })
  async function* chunks(): AsyncGenerator<Uint8Array> {
    const hash = createHash('sha256')
    let position = offset
    try {
      while (!finished && position < ref.bytes) {
        recheck()
        const bytes = await readExact(handle, position, Math.min(CHUNK_BYTES, ref.bytes - position))
        if (finished) return
        hash.update(bytes)
        position += bytes.byteLength
        yield bytes
      }
      if (finished) return
      const digest = hash.digest('hex')
      if (offset === 0 && digest !== ref.digest) refuse('integrity', 'blob bytes do not match their digest')
      finish({ ok: true, value: { bytes: ref.bytes - offset, digest } })
    } catch (caught) {
      finish({ ok: false, error: errorOf(caught) })
    } finally {
      if (!finished) await stop()
    }
  }
  return { chunks: chunks(), ended, cancel: stop, close: stop }
}

export function createBlobService(options: BlobServiceOptions): BlobService {
  const store: BlobStore = openBlobStore(options)
  const verified = new Set<string>()
  let closed = false
  const live = () => {
    if (closed) refuse('blocked', 'blob service is closed')
  }
  /** A call after close is refused with a stable code instead of failing on the closed database. */
  const call = <T>(context: CallContext, body: () => T | Promise<T>) =>
    run(context, () => {
      live()
      return body()
    })

  const authorize = (context: CallContext, ref: Wire.BlobRef) => {
    live()
    if (!options.authorizeRead) refuse('blocked', 'no trusted read delegation is configured')
    if (!options.authorizeRead(context, ref)) refuse('permission_denied', 'caller may not read this blob')
    resolvePin(store, ref)
  }

  /** Opens the content file and checks its full digest once per file identity in this process. */
  async function openContent(ref: Wire.BlobRef): Promise<FileHandle> {
    const path = join(store.dataDir, 'artifacts', 'sha256', ref.digest.slice(0, 2), ref.digest)
    let handle: FileHandle
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch {
      refuse('integrity', 'blob bytes are missing')
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== ref.bytes) refuse('integrity', 'blob bytes do not match their size')
      const identity = `${ref.digest}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
      if (!verified.has(identity)) {
        const hash = createHash('sha256')
        for (let at = 0; at < ref.bytes; at += CHUNK_BYTES)
          hash.update(await readExact(handle, at, Math.min(CHUNK_BYTES, ref.bytes - at)))
        if (hash.digest('hex') !== ref.digest) refuse('integrity', 'blob bytes do not match their digest')
        verified.add(identity)
      }
      return handle
    } catch (caught) {
      await handle.close()
      throw caught
    }
  }

  const blobRead: BlobReadPort = {
    readRange: (request, context) =>
      call(context, async (): Promise<ByteRangeResult> => {
        const { ref, offset, length } = parse('BlobReadRangeRequest', request)
        authorize(context, ref)
        if (offset >= ref.bytes) refuse('range_not_satisfiable', 'range starts at or past the end')
        const handle = await openContent(ref)
        try {
          const bytes = await readExact(handle, offset, Math.min(length, ref.bytes - offset))
          const digest = createHash('sha256').update(bytes).digest('hex')
          return { bytes, offset, totalBytes: ref.bytes, digest }
        } finally {
          await handle.close()
        }
      }),
    openRead: (request, context) =>
      call(context, async () => {
        const { ref, offset } = parse('BlobOpenReadRequest', request)
        authorize(context, ref)
        if (offset > ref.bytes) refuse('range_not_satisfiable', 'stream starts past the end')
        return fileStream(await openContent(ref), ref, offset, () => authorize(context, ref))
      }),
  }

  return Object.freeze({
    binding: options.binding,
    stage: (request, context) => call(context, () => stage(store, request, context)),
    promote: (request, context) => call(context, () => promote(store, request)),
    pin: (request, context) => call(context, () => pin(store, request)),
    unpin: (request, context) => call(context, () => unpin(store, request)),
    gc: (request, context) => call(context, () => gc(store, request, context)),
    inspect: (request, context) => call(context, () => inspect(store, request)),
    blobRead,
    openWriter: (uploadId, context) =>
      closed
        ? { ok: false, error: blobError('blocked', 'blob service is closed') }
        : openUploadWriter(store, uploadId, context),
    close: () => {
      if (closed) return
      closed = true
      store.db.close()
    },
  })
}
