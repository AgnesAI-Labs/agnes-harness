import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import {
  ARTIFACT_READ_RPC_MAX_BYTES,
  type ArtifactReadParams,
  type ArtifactReadResult as ArtifactReadRpcResult,
} from '@agnes/protocol'
import type { AuthenticatedArtifactCaller } from '../artifact-read.js'
import type { LocalEndpoint } from '../endpoint.js'

const MAX_SCOPE_TIMEOUT_MS = 60_000
const UNAVAILABLE = Symbol('artifact-read-scope-unavailable')
const MALFORMED = Symbol('artifact-read-malformed')
const TOO_LARGE = Symbol('artifact-read-too-large')
const HASH = /^[0-9a-f]{64}$/u
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
const intrinsicSet = Uint8Array.prototype.set
const intrinsicPromiseThen = Promise.prototype.then
const FAILURE = Object.freeze({
  invalid_request: Object.freeze({ status: 400 as const, message: 'Artifact request is invalid.' }),
  authentication_required: Object.freeze({
    status: 401 as const,
    message: 'Artifact authentication is required.',
  }),
  artifact_forbidden: Object.freeze({ status: 403 as const, message: 'Artifact access is denied.' }),
  artifact_not_found: Object.freeze({ status: 404 as const, message: 'Artifact is unavailable.' }),
  artifact_identity_mismatch: Object.freeze({
    status: 409 as const,
    message: 'Artifact identity could not be verified.',
  }),
  artifact_reclaimed: Object.freeze({
    status: 410 as const,
    message: 'Artifact was removed by the retention policy.',
  }),
  artifact_too_large: Object.freeze({
    status: 413 as const,
    message: 'Artifact response exceeds the configured limit.',
  }),
  range_not_satisfiable: Object.freeze({
    status: 416 as const,
    message: 'Artifact byte range is not satisfiable.',
  }),
  artifact_unavailable: Object.freeze({ status: 500 as const, message: 'Artifact could not be read.' }),
})
type FailureCode = keyof typeof FAILURE

/**
 * Client-provided session/lane values are only lookup targets. This server-owned port must validate
 * them against the authenticated connection and durable session/lane membership, then return the
 * canonical scope. The RPC layer never treats the request itself as caller identity.
 */
export type ArtifactReadScopeAuthority = Readonly<{
  resolve(
    target: Readonly<{
      principalId: string
      authKind: AuthenticatedArtifactCaller['authKind']
      sessionId: string
      laneId: string
    }>,
    signal: AbortSignal,
  ): Promise<unknown>
}>

export type ArtifactReadRpcOptions = Readonly<{
  read(request: unknown, caller: unknown, signal?: AbortSignal): Promise<unknown>
  scope: ArtifactReadScopeAuthority
  scopeTimeoutMs: number
  /** Defaults to scopeTimeoutMs. The server owns both deadlines; clients cannot override them. */
  readTimeoutMs?: number
}>

function snapshotOptions(value: ArtifactReadRpcOptions): Readonly<{
  read: ArtifactReadRpcOptions['read']
  resolve: ArtifactReadScopeAuthority['resolve']
  scopeTimeoutMs: number
  readTimeoutMs: number
}> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new TypeError('artifact read RPC configuration is invalid')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== 'string' || !['read', 'scope', 'scopeTimeoutMs', 'readTimeoutMs'].includes(key),
    ) ||
    Object.values(descriptors).some(
      (descriptor) => descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value'),
    ) ||
    !['read', 'scope', 'scopeTimeoutMs'].every((key) => {
      const descriptor = descriptors[key]
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
    })
  )
    throw new TypeError('artifact read RPC configuration is invalid')
  const read = descriptors.read?.value as unknown
  const scope = descriptors.scope?.value as unknown
  const timeout = descriptors.scopeTimeoutMs?.value as unknown
  const readTimeout = descriptors.readTimeoutMs?.value as unknown
  if (
    typeof read !== 'function' ||
    utilTypes.isProxy(read) ||
    !scope ||
    typeof scope !== 'object' ||
    Array.isArray(scope) ||
    utilTypes.isProxy(scope) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(scope)) ||
    !Number.isSafeInteger(timeout) ||
    (timeout as number) < 1 ||
    (timeout as number) > MAX_SCOPE_TIMEOUT_MS ||
    (readTimeout !== undefined &&
      (!Number.isSafeInteger(readTimeout) ||
        (readTimeout as number) < 1 ||
        (readTimeout as number) > MAX_SCOPE_TIMEOUT_MS))
  )
    throw new TypeError('artifact read RPC configuration is invalid')
  const scopeDescriptors = Object.getOwnPropertyDescriptors(scope)
  if (
    Reflect.ownKeys(scopeDescriptors).length !== 1 ||
    scopeDescriptors.resolve?.enumerable !== true ||
    !Object.hasOwn(scopeDescriptors.resolve ?? {}, 'value') ||
    typeof scopeDescriptors.resolve?.value !== 'function' ||
    utilTypes.isProxy(scopeDescriptors.resolve.value)
  )
    throw new TypeError('artifact read RPC configuration is invalid')
  return Object.freeze({
    read: read as ArtifactReadRpcOptions['read'],
    resolve: scopeDescriptors.resolve.value as ArtifactReadScopeAuthority['resolve'],
    scopeTimeoutMs: timeout as number,
    readTimeoutMs: (readTimeout ?? timeout) as number,
  })
}

function exactOwn(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value))
      return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const allowed = new Set([...required, ...optional])
    if (
      required.some((key) => !Object.hasOwn(descriptors, key)) ||
      Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      Object.values(descriptors).some(
        (descriptor) => descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value'),
      )
    )
      return undefined
    const copy = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(descriptors) as string[]) copy[key] = descriptors[key]?.value
    return Object.freeze(copy)
  } catch {
    return undefined
  }
}

function boundedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  )
}

function snapshotRef(value: unknown): ArtifactReadParams['artifact'] | undefined {
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

function snapshotRequest(value: unknown): ArtifactReadParams | undefined {
  const request = exactOwn(value, ['sessionId', 'laneId', 'artifact'], ['range'])
  if (!request || !boundedText(request.sessionId) || !boundedText(request.laneId)) return undefined
  const artifact = snapshotRef(request.artifact)
  if (
    !artifact ||
    (request.range !== undefined &&
      (typeof request.range !== 'string' || request.range.length < 1 || request.range.length > 128))
  )
    return undefined
  return Object.freeze({
    sessionId: request.sessionId,
    laneId: request.laneId,
    artifact,
    ...(request.range === undefined ? {} : { range: request.range as string }),
  })
}

function snapshotScope(value: unknown): Readonly<{ sessionId: string; laneId: string }> | undefined {
  const scope = exactOwn(value, ['sessionId', 'laneId'])
  if (!scope || !boundedText(scope.sessionId) || !boundedText(scope.laneId)) return undefined
  return Object.freeze({ sessionId: scope.sessionId, laneId: scope.laneId })
}

async function resolveScope(
  resolve: ArtifactReadScopeAuthority['resolve'],
  target: Parameters<ArtifactReadScopeAuthority['resolve']>[0],
  externalSignal: AbortSignal,
  timeoutMs: number,
): Promise<unknown | typeof UNAVAILABLE> {
  if (externalSignal.aborted) return UNAVAILABLE
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbortListener: (() => void) | undefined
  try {
    const stopped = new Promise<typeof UNAVAILABLE>((settle) => {
      const stop = () => {
        controller.abort()
        settle(UNAVAILABLE)
      }
      timer = setTimeout(stop, timeoutMs)
      timer.unref?.()
      externalSignal.addEventListener('abort', stop, { once: true })
      removeAbortListener = () => externalSignal.removeEventListener('abort', stop)
    })
    const completed = Promise.resolve()
      .then(() => Reflect.apply(resolve, undefined, [target, controller.signal]) as Promise<unknown>)
      .catch(() => UNAVAILABLE)
    return await Promise.race([completed, stopped])
  } catch {
    controller.abort()
    return UNAVAILABLE
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    try {
      removeAbortListener?.()
    } catch {
      // Authentication failures use one fixed unavailable response and never expose signal errors.
    }
  }
}

async function readWithinDeadline(
  read: ArtifactReadRpcOptions['read'],
  request: ArtifactReadParams,
  caller: AuthenticatedArtifactCaller,
  externalSignal: AbortSignal,
  timeoutMs: number,
): Promise<Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>> {
  const unavailable = Object.freeze({ ok: false as const })
  if (externalSignal.aborted) return unavailable
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbortListener: (() => void) | undefined
  try {
    const stopped = new Promise<Readonly<{ ok: false }>>((settle) => {
      const stop = () => {
        controller.abort()
        settle(unavailable)
      }
      timer = setTimeout(stop, timeoutMs)
      timer.unref?.()
      externalSignal.addEventListener('abort', stop, { once: true })
      removeAbortListener = () => externalSignal.removeEventListener('abort', stop)
    })
    const returned = Reflect.apply(read, undefined, [request, caller, controller.signal]) as unknown
    const completed: Promise<Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>> =
      utilTypes.isProxy(returned)
        ? Promise.resolve(unavailable)
        : isOrdinaryPromise(returned)
          ? (Reflect.apply(intrinsicPromiseThen, returned, [
              (value: unknown) => Object.freeze({ ok: true as const, value }),
              () => unavailable,
            ]) as Promise<Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>>)
          : Promise.resolve(Object.freeze({ ok: true as const, value: returned }))
    return await Promise.race([completed, stopped])
  } catch {
    controller.abort()
    return unavailable
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    try {
      removeAbortListener?.()
    } catch {
      // Read failures use one fixed unavailable response and never expose signal errors.
    }
  }
}

type ByteRange = Readonly<{ start: number; endExclusive: number }>

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
  return Object.freeze({ start, endExclusive: Math.min(size, inclusiveEnd + 1) })
}

function snapshotBytes(value: unknown, expectedLength: number): Uint8Array | typeof TOO_LARGE | undefined {
  try {
    if (
      !byteLengthGetter ||
      !bufferGetter ||
      !value ||
      typeof value !== 'object' ||
      utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Uint8Array.prototype
    )
      return undefined
    const buffer = Reflect.apply(bufferGetter, value, []) as unknown
    if (utilTypes.isSharedArrayBuffer(buffer)) return undefined
    const byteLength = Reflect.apply(byteLengthGetter, value, []) as unknown
    if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0) return undefined
    if ((byteLength as number) > ARTIFACT_READ_RPC_MAX_BYTES) return TOO_LARGE
    if (byteLength !== expectedLength) return undefined
    const copy = new Uint8Array(expectedLength)
    Reflect.apply(intrinsicSet, copy, [value])
    return copy
  } catch {
    return undefined
  }
}

function isOrdinaryPromise(value: unknown): value is Promise<unknown> {
  try {
    return (
      !!value &&
      typeof value === 'object' &&
      !utilTypes.isProxy(value) &&
      utilTypes.isPromise(value) &&
      Object.getPrototypeOf(value) === Promise.prototype &&
      Reflect.ownKeys(Object.getOwnPropertyDescriptors(value)).length === 0
    )
  } catch {
    return false
  }
}

function sameRef(left: ArtifactReadParams['artifact'], right: ArtifactReadParams['artifact']): boolean {
  return left.sha256 === right.sha256 && left.size === right.size && left.mime === right.mime
}

function adaptReadResult(
  value: unknown,
  request: ArtifactReadParams,
): ArtifactReadRpcResult | typeof MALFORMED | typeof TOO_LARGE {
  const root = exactOwn(value, ['ok', 'status', 'code', 'message'])
  if (root?.ok === false && typeof root.code === 'string' && Object.hasOwn(FAILURE, root.code)) {
    const code = root.code as FailureCode
    const expected = FAILURE[code]
    if (root.status !== expected.status || root.message !== expected.message) return MALFORMED
    return Object.freeze({ ok: false, status: expected.status, code }) as ArtifactReadRpcResult
  }

  const success = exactOwn(value, ['ok', 'status', 'artifact', 'headers', 'body'])
  if (success?.ok !== true || (success.status !== 200 && success.status !== 206)) return MALFORMED
  const artifact = snapshotRef(success.artifact)
  if (!artifact || !sameRef(artifact, request.artifact)) return MALFORMED
  const headers = exactOwn(
    success.headers,
    ['acceptRanges', 'contentLength', 'contentType', 'etag'],
    ['contentRange'],
  )
  if (
    headers?.acceptRanges !== 'bytes' ||
    headers.contentType !== artifact.mime ||
    headers.etag !== `"${artifact.sha256}"` ||
    !Number.isSafeInteger(headers.contentLength) ||
    (headers.contentLength as number) < 0
  )
    return MALFORMED
  const range = parseRange(request.range, artifact.size)
  if (range === null) return MALFORMED
  const expectedLength = range ? range.endExclusive - range.start : artifact.size
  const expectedContentRange = range
    ? `bytes ${range.start}-${range.endExclusive - 1}/${artifact.size}`
    : undefined
  if (
    headers.contentLength !== expectedLength ||
    (range === undefined
      ? success.status !== 200 || headers.contentRange !== undefined
      : success.status !== 206 || headers.contentRange !== expectedContentRange)
  )
    return MALFORMED
  const body = snapshotBytes(success.body, expectedLength)
  if (body === TOO_LARGE) return TOO_LARGE
  if (!body) return MALFORMED
  if (range === undefined && createHash('sha256').update(body).digest('hex') !== artifact.sha256)
    return MALFORMED
  return Object.freeze({
    ok: true,
    status: success.status,
    artifact,
    acceptRanges: 'bytes',
    contentLength: expectedLength,
    etag: `"${artifact.sha256}"`,
    ...(expectedContentRange === undefined ? {} : { contentRange: expectedContentRange }),
    base64: Buffer.from(body).toString('base64'),
  }) as ArtifactReadRpcResult
}

const failure = <Code extends FailureCode>(code: Code): ArtifactReadRpcResult =>
  Object.freeze({ ok: false, status: FAILURE[code].status, code }) as ArtifactReadRpcResult

/** Register the bounded JSON-RPC byte channel; it deliberately does not create an HTTP/file route. */
export function registerArtifactRead(ep: LocalEndpoint, options: ArtifactReadRpcOptions): void {
  const configured = snapshotOptions(options)
  ep.register('_agnes/v1/artifact.read', async (params, context): Promise<ArtifactReadRpcResult> => {
    const request = snapshotRequest(params)
    if (!request) return failure('invalid_request')
    const authKind = context.conn.authKind
    if (!authKind) return failure('authentication_required')
    const target = Object.freeze({
      principalId: context.conn.principalId,
      authKind,
      sessionId: request.sessionId,
      laneId: request.laneId,
    })
    const rawScope = await resolveScope(configured.resolve, target, context.signal, configured.scopeTimeoutMs)
    if (rawScope === UNAVAILABLE) return failure('artifact_unavailable')
    if (rawScope === undefined) return failure('artifact_forbidden')
    const scope = snapshotScope(rawScope)
    if (!scope) return failure('artifact_unavailable')
    if (scope.sessionId !== request.sessionId || scope.laneId !== request.laneId)
      return failure('artifact_forbidden')

    const caller: AuthenticatedArtifactCaller = Object.freeze({
      principalId: context.conn.principalId,
      authKind,
      sessionId: scope.sessionId,
      laneId: scope.laneId,
    })
    const readResult = await readWithinDeadline(
      configured.read,
      request,
      caller,
      context.signal,
      configured.readTimeoutMs,
    )
    if (!readResult.ok) return failure('artifact_unavailable')
    const result = adaptReadResult(readResult.value, request)
    if (result === TOO_LARGE) return failure('artifact_too_large')
    return result === MALFORMED ? failure('artifact_unavailable') : result
  })
}
