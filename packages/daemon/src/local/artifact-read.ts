import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { ARTIFACT_RECLAIMED_FAILURE } from '@agnes/host'
import type { ArtifactRef } from '@agnes/protocol'

const HASH = /^[0-9a-f]{64}$/u
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u
const AUTH_KINDS = new Set(['local', 'jwt', 'source-auth', 'portal-identity', 'surface'])

export type AuthenticatedArtifactCaller = Readonly<{
  principalId: string
  sessionId: string
  laneId: string
  authKind: 'local' | 'jwt' | 'source-auth' | 'portal-identity' | 'surface'
}>

export type ArtifactReadRequest = Readonly<{
  sessionId: string
  laneId: string
  artifact: ArtifactRef
  /** One RFC 7233 byte range. Multiple ranges are intentionally unsupported. */
  range?: string
}>

export type ArtifactReadAuthority = Readonly<{
  sessionId: string
  laneId: string
  ownerId: string
  artifact: ArtifactRef
}>

export type ArtifactReadAuthorityPort = Readonly<{
  resolve(sessionId: string, laneId: string, sha256: string, signal: AbortSignal): Promise<unknown>
}>

export type ArtifactReadStore = Readonly<{
  get(ref: ArtifactRef, signal: AbortSignal): Promise<unknown>
}>

export type ArtifactReadFailure = Readonly<{
  ok: false
  status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 416 | 500
  code:
    | 'invalid_request'
    | 'authentication_required'
    | 'artifact_forbidden'
    | 'artifact_not_found'
    | 'artifact_identity_mismatch'
    | 'artifact_reclaimed'
    | 'artifact_too_large'
    | 'range_not_satisfiable'
    | 'artifact_unavailable'
  message: string
}>

export type ArtifactReadSuccess = Readonly<{
  ok: true
  status: 200 | 206
  artifact: ArtifactRef
  headers: Readonly<{
    acceptRanges: 'bytes'
    contentLength: number
    contentType: string
    etag: string
    contentRange?: string
  }>
  body: Readonly<Uint8Array>
}>

export type ArtifactReadResult = ArtifactReadSuccess | ArtifactReadFailure

/** A screenshot retention reclaimed on purpose, as distinct from one that cannot be read. */
export type TrustedArtifactReclaimed = Readonly<{ reclaimed: true }>

export type TrustedSessionArtifactRead = (
  request: unknown,
  signal?: AbortSignal,
) => Promise<ArtifactReadSuccess | TrustedArtifactReclaimed | undefined>

type Limits = Readonly<{ maxArtifactBytes: number; maxResponseBytes: number }>
type ByteRange = Readonly<{ start: number; endExclusive: number }>
type PortResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reclaimed?: true }>

const MAX_OPERATION_TIMEOUT_MS = 60_000
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
const intrinsicSet = Uint8Array.prototype.set

function failure(
  status: ArtifactReadFailure['status'],
  code: ArtifactReadFailure['code'],
): ArtifactReadFailure {
  const messages: Record<ArtifactReadFailure['code'], string> = {
    invalid_request: 'Artifact request is invalid.',
    authentication_required: 'Artifact authentication is required.',
    artifact_forbidden: 'Artifact access is denied.',
    artifact_not_found: 'Artifact is unavailable.',
    artifact_identity_mismatch: 'Artifact identity could not be verified.',
    artifact_reclaimed: 'Artifact was removed by the retention policy.',
    artifact_too_large: 'Artifact response exceeds the configured limit.',
    range_not_satisfiable: 'Artifact byte range is not satisfiable.',
    artifact_unavailable: 'Artifact could not be read.',
  }
  return Object.freeze({ ok: false, status, code, message: messages[code] })
}

function exactOwn(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value))
      return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    const allowed = new Set([...required, ...optional])
    if (
      required.some((key) => !Object.hasOwn(descriptors, key)) ||
      keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      Object.values(descriptors).some(
        (descriptor) => descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value'),
      )
    )
      return undefined
    const copy = Object.create(null) as Record<string, unknown>
    for (const key of keys as string[]) copy[key] = descriptors[key]?.value
    return Object.freeze(copy)
  } catch {
    return undefined
  }
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  )
}

function snapshotRef(value: unknown): ArtifactRef | undefined {
  const ref = exactOwn(value, ['sha256', 'size', 'mime'])
  if (
    !ref ||
    typeof ref.sha256 !== 'string' ||
    !HASH.test(ref.sha256) ||
    !Number.isSafeInteger(ref.size) ||
    (ref.size as number) < 0 ||
    typeof ref.mime !== 'string' ||
    !MIME.test(ref.mime)
  )
    return undefined
  return Object.freeze({ sha256: ref.sha256, size: ref.size as number, mime: ref.mime })
}

function snapshotCaller(value: unknown): AuthenticatedArtifactCaller | undefined {
  const caller = exactOwn(value, ['principalId', 'sessionId', 'laneId', 'authKind'])
  if (
    !caller ||
    !boundedText(caller.principalId, 512) ||
    !boundedText(caller.sessionId, 512) ||
    !boundedText(caller.laneId, 512) ||
    typeof caller.authKind !== 'string' ||
    !AUTH_KINDS.has(caller.authKind)
  )
    return undefined
  return Object.freeze({
    principalId: caller.principalId,
    sessionId: caller.sessionId,
    laneId: caller.laneId,
    authKind: caller.authKind as AuthenticatedArtifactCaller['authKind'],
  })
}

function snapshotRequest(value: unknown): ArtifactReadRequest | undefined {
  const request = exactOwn(value, ['sessionId', 'laneId', 'artifact'], ['range'])
  if (!request || !boundedText(request.sessionId, 512) || !boundedText(request.laneId, 512)) return undefined
  const artifact = snapshotRef(request.artifact)
  if (!artifact || (request.range !== undefined && typeof request.range !== 'string')) return undefined
  if (typeof request.range === 'string' && (request.range.length < 1 || request.range.length > 128))
    return undefined
  return Object.freeze({
    sessionId: request.sessionId,
    laneId: request.laneId,
    artifact,
    ...(request.range === undefined ? {} : { range: request.range as string }),
  })
}

function snapshotAuthority(value: unknown): ArtifactReadAuthority | undefined {
  const authority = exactOwn(value, ['sessionId', 'laneId', 'ownerId', 'artifact'])
  if (
    !authority ||
    !boundedText(authority.sessionId, 512) ||
    !boundedText(authority.laneId, 512) ||
    !boundedText(authority.ownerId, 512)
  )
    return undefined
  const artifact = snapshotRef(authority.artifact)
  if (!artifact) return undefined
  return Object.freeze({
    sessionId: authority.sessionId,
    laneId: authority.laneId,
    ownerId: authority.ownerId,
    artifact,
  })
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.sha256 === right.sha256 && left.size === right.size && left.mime === right.mime
}

function parseRange(value: string | undefined, size: number): ByteRange | undefined | null {
  if (value === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value)
  if (!match || (!match[1] && !match[2]) || size === 0) return null
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    const length = Math.min(suffix, size)
    return Object.freeze({ start: size - length, endExclusive: size })
  }
  const start = Number(match[1])
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null
  if (!match[2]) return Object.freeze({ start, endExclusive: size })
  const inclusiveEnd = Number(match[2])
  if (!Number.isSafeInteger(inclusiveEnd) || inclusiveEnd < start) return null
  return Object.freeze({
    start,
    endExclusive: inclusiveEnd >= size - 1 ? size : inclusiveEnd + 1,
  })
}

function validLimits(value: Limits): boolean {
  return (
    Number.isSafeInteger(value.maxArtifactBytes) &&
    value.maxArtifactBytes >= 0 &&
    Number.isSafeInteger(value.maxResponseBytes) &&
    value.maxResponseBytes >= 0 &&
    value.maxResponseBytes <= value.maxArtifactBytes
  )
}

function snapshotConstructor(value: unknown):
  | Readonly<{
      resolve: ArtifactReadAuthorityPort['resolve']
      get: ArtifactReadStore['get']
      limits: Limits
      operationTimeoutMs: number
    }>
  | undefined {
  const input = exactOwn(value, ['authority', 'artifacts', 'limits', 'operationTimeoutMs'])
  if (!input) return undefined
  const authority = exactOwn(input.authority, ['resolve'])
  const artifacts = exactOwn(input.artifacts, ['get'])
  const limits = exactOwn(input.limits, ['maxArtifactBytes', 'maxResponseBytes'])
  if (
    !authority ||
    !artifacts ||
    typeof authority.resolve !== 'function' ||
    utilTypes.isProxy(authority.resolve) ||
    typeof artifacts.get !== 'function' ||
    utilTypes.isProxy(artifacts.get) ||
    !limits ||
    !validLimits(limits as Limits) ||
    !Number.isSafeInteger(input.operationTimeoutMs) ||
    (input.operationTimeoutMs as number) < 1 ||
    (input.operationTimeoutMs as number) > MAX_OPERATION_TIMEOUT_MS
  )
    return undefined
  return Object.freeze({
    resolve: authority.resolve as ArtifactReadAuthorityPort['resolve'],
    get: artifacts.get as ArtifactReadStore['get'],
    limits: Object.freeze({
      maxArtifactBytes: limits.maxArtifactBytes as number,
      maxResponseBytes: limits.maxResponseBytes as number,
    }),
    operationTimeoutMs: input.operationTimeoutMs as number,
  })
}

async function runPort<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  externalSignal: AbortSignal | undefined,
  operationTimeoutMs: number,
): Promise<PortResult<T>> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let removeAbortListener: (() => void) | undefined
  try {
    if (externalSignal?.aborted) return Object.freeze({ ok: false })
    const aborted = new Promise<PortResult<T>>((resolve) => {
      const stop = () => {
        controller.abort()
        resolve(Object.freeze({ ok: false }))
      }
      timeout = setTimeout(stop, operationTimeoutMs)
      timeout.unref?.()
      if (externalSignal) {
        externalSignal.addEventListener('abort', stop, { once: true })
        removeAbortListener = () => externalSignal.removeEventListener('abort', stop)
      }
    })
    const completed: Promise<PortResult<T>> = Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value): PortResult<T> => Object.freeze({ ok: true, value }),
        (error: unknown): PortResult<T> =>
          Object.freeze(
            error === ARTIFACT_RECLAIMED_FAILURE ? { ok: false, reclaimed: true } : { ok: false },
          ),
      )
    return await Promise.race([completed, aborted])
  } catch {
    controller.abort()
    return Object.freeze({ ok: false })
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    try {
      removeAbortListener?.()
    } catch {
      // The boundary always returns its fixed unavailable error for hostile signals.
    }
  }
}

function snapshotBytes(value: unknown, expectedSize: number): Uint8Array | undefined {
  try {
    if (
      !byteLengthGetter ||
      !value ||
      typeof value !== 'object' ||
      utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Uint8Array.prototype
    )
      return undefined
    const byteLength = Reflect.apply(byteLengthGetter, value, []) as unknown
    if (byteLength !== expectedSize) return undefined
    const copy = new Uint8Array(expectedSize)
    Reflect.apply(intrinsicSet, copy, [value])
    return copy
  } catch {
    return undefined
  }
}

/**
 * Production-shaped read primitive only. A route must supply server-authenticated caller facts and
 * an ownership resolver; request data never selects a filesystem path or an artifact store key.
 */
export function createAuthenticatedArtifactReadHandler(
  input: Readonly<{
    authority: ArtifactReadAuthorityPort
    artifacts: ArtifactReadStore
    limits: Limits
    operationTimeoutMs: number
  }>,
): (request: unknown, caller: unknown, signal?: AbortSignal) => Promise<ArtifactReadResult> {
  const configuration = snapshotConstructor(input)
  if (!configuration) throw new TypeError('artifact read configuration is invalid')
  const { limits } = configuration
  return async (requestValue, callerValue, signal) => {
    const request = snapshotRequest(requestValue)
    if (!request) return failure(400, 'invalid_request')
    const caller = snapshotCaller(callerValue)
    if (!caller) return failure(401, 'authentication_required')
    if (request.sessionId !== caller.sessionId || request.laneId !== caller.laneId)
      return failure(403, 'artifact_forbidden')
    if (request.artifact.size > limits.maxArtifactBytes) return failure(413, 'artifact_too_large')
    if (signal?.aborted) return failure(500, 'artifact_unavailable')

    const resolved = await runPort(
      (operationSignal) =>
        Reflect.apply(configuration.resolve, undefined, [
          request.sessionId,
          request.laneId,
          request.artifact.sha256,
          operationSignal,
        ]) as Promise<unknown>,
      signal,
      configuration.operationTimeoutMs,
    )
    if (!resolved.ok) return failure(500, 'artifact_unavailable')
    const authority = snapshotAuthority(resolved.value)
    if (!authority) return failure(404, 'artifact_not_found')
    if (
      authority.sessionId !== request.sessionId ||
      authority.laneId !== request.laneId ||
      authority.ownerId !== caller.principalId
    )
      return failure(403, 'artifact_forbidden')
    if (!sameRef(authority.artifact, request.artifact)) return failure(409, 'artifact_identity_mismatch')
    if (authority.artifact.size > limits.maxArtifactBytes) return failure(413, 'artifact_too_large')
    const range = parseRange(request.range, authority.artifact.size)
    if (range === null) return failure(416, 'range_not_satisfiable')
    const responseLength = range ? range.endExclusive - range.start : authority.artifact.size
    if (responseLength > limits.maxResponseBytes) return failure(413, 'artifact_too_large')
    if (signal?.aborted) return failure(500, 'artifact_unavailable')

    const loaded = await runPort(
      (operationSignal) =>
        Reflect.apply(configuration.get, undefined, [
          authority.artifact,
          operationSignal,
        ]) as Promise<unknown>,
      signal,
      configuration.operationTimeoutMs,
    )
    // Only reached after the caller, the binding and the reference were all authorized above.
    if (!loaded.ok)
      return loaded.reclaimed ? failure(410, 'artifact_reclaimed') : failure(500, 'artifact_unavailable')
    if (signal?.aborted) return failure(500, 'artifact_unavailable')
    const bytes = snapshotBytes(loaded.value, authority.artifact.size)
    if (!bytes) return failure(409, 'artifact_identity_mismatch')
    if (createHash('sha256').update(bytes).digest('hex') !== authority.artifact.sha256)
      return failure(409, 'artifact_identity_mismatch')
    const body = range ? bytes.slice(range.start, range.endExclusive) : bytes
    return Object.freeze({
      ok: true,
      status: range ? 206 : 200,
      artifact: authority.artifact,
      headers: Object.freeze({
        acceptRanges: 'bytes',
        contentLength: body.byteLength,
        contentType: authority.artifact.mime,
        etag: `"${authority.artifact.sha256}"`,
        ...(range === undefined
          ? {}
          : { contentRange: `bytes ${range.start}-${range.endExclusive - 1}/${authority.artifact.size}` }),
      }),
      body,
    })
  }
}

/**
 * Private worker read path. The supervisor supplies the session identity from the authenticated
 * worker link; the worker may name only a lane and digest. The durable authority still supplies the
 * complete ref and owner, then the normal authenticated reader rechecks the same binding and bytes.
 */
export function createTrustedSessionArtifactReadHandler(
  input: Readonly<{
    authority: ArtifactReadAuthorityPort
    artifacts: ArtifactReadStore
    limits: Limits
    operationTimeoutMs: number
  }>,
): TrustedSessionArtifactRead {
  const configuration = snapshotConstructor(input)
  if (!configuration) throw new TypeError('artifact read configuration is invalid')
  const read = createAuthenticatedArtifactReadHandler(input)
  return async (requestValue, signal) => {
    const request = exactOwn(requestValue, ['sessionId', 'laneId', 'ownerId', 'sha256'])
    if (
      !request ||
      !boundedText(request.sessionId, 512) ||
      !boundedText(request.laneId, 512) ||
      !boundedText(request.ownerId, 512) ||
      typeof request.sha256 !== 'string' ||
      !HASH.test(request.sha256) ||
      signal?.aborted
    )
      return undefined
    const resolved = await runPort(
      (operationSignal) =>
        Reflect.apply(configuration.resolve, undefined, [
          request.sessionId,
          request.laneId,
          request.sha256,
          operationSignal,
        ]) as Promise<unknown>,
      signal,
      configuration.operationTimeoutMs,
    )
    if (!resolved.ok) return undefined
    const authority = snapshotAuthority(resolved.value)
    if (
      !authority ||
      authority.sessionId !== request.sessionId ||
      authority.laneId !== request.laneId ||
      authority.ownerId !== request.ownerId ||
      authority.artifact.sha256 !== request.sha256
    )
      return undefined
    const result = await read(
      { sessionId: authority.sessionId, laneId: authority.laneId, artifact: authority.artifact },
      {
        principalId: authority.ownerId,
        sessionId: authority.sessionId,
        laneId: authority.laneId,
        authKind: 'local',
      },
      signal,
    )
    if (!result.ok)
      return result.code === 'artifact_reclaimed' ? Object.freeze({ reclaimed: true }) : undefined
    return result
  }
}
