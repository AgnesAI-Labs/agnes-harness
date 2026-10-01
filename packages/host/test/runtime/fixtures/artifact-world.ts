import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { StatementSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  BlobReadPort,
  BoundService,
  CallContext,
  Outcome,
  ScopedDependencies,
  ScopeRef,
} from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { RuntimeClientTransportPolicy, RuntimeSchemaRefs } from '@agnes/protocol/runtime'
import { blobError } from '../../../src/runtime/blob/uploads.js'
import {
  type ArtifactsService,
  BLOB_REQUIREMENT,
  createArtifactsService,
  type OwnerAction,
  type SelectedBlobActions,
} from '../../../src/runtime/providers/artifacts.js'
import { type BlobService, createBlobService } from '../../../src/runtime/providers/blob.js'

/** Shared setup for the artifact and blob tests that kill real processes or move large content. */

export const MIB = RuntimeClientTransportPolicy.maxRangeBytes
export const BLOB_BINDING = {
  bindingId: 'blob-1',
  contract: 'agh.blob',
  logicalName: 'default',
  providerId: 'agh.blob.default',
}
export const SCOPE: ScopeRef = {
  kind: 'session',
  installationId: 'install-1',
  runtimeId: 'runtime-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
}

export function ctx(over: Partial<Pick<CallContext, 'principalRef' | 'authorizationRef'>> = {}): CallContext {
  return {
    principalRef: 'user-1',
    scope: SCOPE,
    bindingId: 'artifacts-1',
    invocationId: 'invocation-1',
    deadline: '2026-10-02T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'auth-ok',
    signal: new AbortController().signal,
    ...over,
  }
}

export function owner(actionId = 'action-1'): OwnerAction {
  return {
    run: {
      runId: 'run-1',
      session: {
        sessionId: 'session-1',
        authority: { authorityId: 'state-1', tenantId: 'tenant-1', authorityEpoch: 1 },
      },
    },
    actionId,
  }
}

export function ok<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`${outcome.error.detailCode}: ${outcome.error.message}`)
  return outcome.value
}

export function refused(outcome: Outcome<unknown>): string {
  if (outcome.ok) throw new Error('expected a refusal')
  return outcome.error.detailCode
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * Deterministic content of any size: each 4-byte word is a bijective hash of its index and the salt,
 * so a byte read from the wrong place never matches. Any range can be regenerated on its own.
 */
export function pattern(offset: number, length: number, salt = 0): Uint8Array {
  const first = Math.floor(offset / 4)
  const words = new Uint32Array(Math.ceil((offset + length) / 4) - first)
  for (let index = 0; index < words.length; index++)
    words[index] = Math.imul((first + index) ^ salt, 0x9e3779b1)
  return new Uint8Array(words.buffer, offset - first * 4, length)
}

export function patternDigest(offset: number, end: number, salt = 0): string {
  const hash = createHash('sha256')
  for (let at = offset; at < end; at += 8 * MIB) hash.update(pattern(at, Math.min(8 * MIB, end - at), salt))
  return hash.digest('hex')
}

export type Content = Readonly<{
  uploadId: string
  bytes: number
  salt: number
  mediaType: string
  chunkBytes: number
  /** Declared at stage. Without it a sealed upload cannot be rebuilt after a restart. */
  digest: string | null
}>

export const PUBLICATION = 'publication-1'
export const PUBLICATION_CONTENT: Content = {
  uploadId: 'upload-1',
  bytes: 2 * MIB + 333,
  salt: 0x51,
  mediaType: 'text/plain',
  chunkBytes: MIB,
  digest: patternDigest(0, 2 * MIB + 333, 0x51),
}

export type Services = Readonly<{ blob: BlobService; artifacts: ArtifactsService; close(): void }>

/**
 * The blob service the default artifacts service selects. Child processes assemble without the
 * test service container, which only test files may import.
 */
function selectedBlob(bound: BoundService): ScopedDependencies {
  const dependencies: ScopedDependencies = {
    get: (requirement) =>
      requirement.contract === BLOB_REQUIREMENT.contract && requirement.major === BLOB_REQUIREMENT.major
        ? { ok: true, value: bound }
        : { ok: false, error: blobError('not_found', 'service is not registered') },
    openScope: async () => ({ ok: true, value: dependencies }),
    close: async () => undefined,
  }
  return dependencies
}

/** The default artifacts service over the default blob service, as artifacts.test.ts assembles them. */
export function openServices(
  dataDir: string,
  options: {
    now?: () => number
    actions?: (blob: BlobService) => Partial<SelectedBlobActions>
    read?: (port: BlobReadPort) => BlobReadPort
  } = {},
): Services {
  const trusted = (context: CallContext) => context.authorizationRef === 'auth-ok'
  const clock = options.now ? { now: options.now } : {}
  const blob = createBlobService({
    dataDir,
    authorityId: 'blob-authority',
    binding: BLOB_BINDING,
    authorizeRead: trusted,
    ...clock,
  })
  const assembled = createArtifactsService({
    dataDir,
    authorityId: 'artifacts-authority',
    dependencies: selectedBlob({
      binding: BLOB_BINDING,
      blobRead: options.read ? options.read(blob.blobRead) : blob.blobRead,
      query: async () => ({ ok: false, error: blobError('operation_not_supported', 'no query') }),
      compute: async () => ({ ok: false, error: blobError('operation_not_supported', 'no compute') }),
    }),
    blobActions: { ...blob, ...options.actions?.(blob) },
    authorize: trusted,
    ...clock,
  })
  if (!assembled.ok) {
    blob.close()
    throw new Error(assembled.error.message)
  }
  const artifacts = assembled.value
  return {
    blob,
    artifacts,
    close() {
      artifacts.close()
      blob.close()
    },
  }
}

/**
 * Stages the upload and writes it from the offset the store acknowledged, so a restarted writer
 * resumes. An upload sealed before a restart is rebuilt from its stored session.
 */
export async function upload(
  blob: BlobService,
  content: Content,
  hooks: {
    staged?(session: Wire.UploadSession): void
    chunk?(session: Wire.UploadSession, bytes: Uint8Array): Promise<void> | void
    sealed?(result: Wire.UploadResult): void
  } = {},
): Promise<Wire.UploadRef> {
  const { uploadId, bytes: size, mediaType, digest } = content
  const session = ok(await blob.stage({ uploadId, size, mediaType, expectedDigest: digest }, ctx()))
  hooks.staged?.(session)
  if (session.status === 'sealed') {
    if (digest === null) throw new Error('a sealed upload without a declared digest cannot be rebuilt')
    const { authorityId, reservationId } = session
    return { authorityId, uploadId, reservationId, digest, bytes: size, mediaType, status: 'sealed' }
  }
  const writer = ok(blob.openWriter(uploadId, ctx()))
  try {
    for (let at = session.receivedBytes; at < size; at += content.chunkBytes) {
      const bytes = pattern(at, Math.min(content.chunkBytes, size - at), content.salt)
      const written = ok(writer.write(at, bytes))
      await hooks.chunk?.(written, bytes)
    }
    const result = ok(await writer.seal())
    hooks.sealed?.(result)
    return result.upload
  } finally {
    writer.close()
  }
}

export function reserveRequest(publicationId: string, over: Record<string, unknown> = {}) {
  const descriptor = RuntimeSchemaRefs.ArtifactContentDescriptor
  return {
    publicationId,
    artifactId: null,
    expectedLatestVersion: null,
    kind: descriptor.typeId,
    schema: descriptor,
    title: null,
    mediaType: null,
    ownerActionRef: { existingActionId: 'action-1' },
    ...over,
  }
}

export const publishRequest = (publicationId: string, upload: Wire.UploadRef, title = 'Report') => ({
  publicationId,
  source: { kind: 'upload', upload },
  expectedRevision: 1,
  title,
  mediaType: upload.mediaType,
})

export async function grantRead(artifacts: ArtifactsService, artifactRef: Wire.ArtifactRef) {
  return ok(
    await artifacts.grant(
      {
        request: {
          requestId: `grant-${artifactRef.artifactId}-${artifactRef.version}`,
          artifactRef,
          granteePrincipalRef: 'user-1',
          scope: SCOPE,
          permissions: ['read', 'download'],
          expiresAt: null,
        },
        owner: owner(),
        sourceAuthorizationRef: 'policy-1',
      },
      ctx(),
    ),
  )
}

// Child side. Output is written synchronously so a line is out before the process blocks or dies.

export function report(event: string, data: unknown = null): void {
  writeSync(1, `${JSON.stringify({ event, data })}\n`)
}

/** Reports the pause, then keeps the process alive doing nothing until the parent kills it. */
export async function hold(point: string, data: unknown = null): Promise<never> {
  report('paused', { point, data })
  setInterval(() => undefined, 60_000)
  return new Promise<never>(() => undefined)
}

/**
 * Blocks the process inside the first SQLite statement that `matches`, so the enclosing transaction
 * has run its earlier statements and has not committed when the parent kills the process.
 */
export function haltAtStatement(point: string, matches: (sql: string) => boolean): void {
  const run = StatementSync.prototype.run as (...args: unknown[]) => unknown
  StatementSync.prototype.run = function (this: StatementSync, ...args: unknown[]) {
    if (matches(this.sourceSQL.replace(/\s+/g, ' ').trim())) {
      report('paused', { point, data: args })
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    }
    return run.apply(this, args)
  } as StatementSync['run']
}

// Parent side.

// The loader runs in the child itself: the tsx CLI would start a second process that a kill misses.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

export type Reported = Readonly<{ event: string; data: unknown }>

export type Child = Readonly<{
  events: readonly Reported[]
  /** The data of the first report of `event` (and `point`, for a pause); fails if the child ends first. */
  until(event: string, point?: string): Promise<unknown>
  kill(): Promise<void>
  /** Waits for a clean exit. */
  done(): Promise<void>
}>

/** Starts a fixture script under tsx. Children are synchronized only on the lines they report. */
export function startChild(script: string, args: readonly string[]): Child {
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', tsx, fileURLToPath(new URL(script, import.meta.url)), ...args],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const events: Reported[] = []
  const waiters = new Set<() => void>()
  let stdout = ''
  let stderr = ''
  let closed = false
  const notify = () => {
    for (const waiter of [...waiters]) waiter()
  }
  const ended = new Promise<number | null>((resolve) =>
    child.once('close', (code) => {
      closed = true
      resolve(code)
      notify()
    }),
  )
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
    for (let end = stdout.indexOf('\n'); end >= 0; end = stdout.indexOf('\n')) {
      events.push(JSON.parse(stdout.slice(0, end)) as Reported)
      stdout = stdout.slice(end + 1)
    }
    notify()
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  const matches = (item: Reported, event: string, point?: string) =>
    item.event === event && (point === undefined || (item.data as { point?: string }).point === point)
  return {
    events,
    until: (event, point) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const found = events.find((item) => matches(item, event, point))
          if (found) {
            waiters.delete(check)
            resolve(point === undefined ? found.data : (found.data as { data: unknown }).data)
          } else if (closed) {
            waiters.delete(check)
            reject(new Error(`child ended before reporting ${event} ${point ?? ''}\n${stderr}`))
          }
        }
        waiters.add(check)
        check()
      }),
    async kill() {
      if (!closed) child.kill('SIGKILL')
      await ended
    },
    async done() {
      const code = await ended
      if (code !== 0) throw new Error(`child exited with ${code}\n${stderr}`)
    },
  }
}
