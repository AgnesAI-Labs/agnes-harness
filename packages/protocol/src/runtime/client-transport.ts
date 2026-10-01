import type { ClientJsonOperation, ClientOperationTypes } from '../../gen/ts/runtime-client-transport.js'
import {
  RuntimeClientErrorSlots,
  RuntimeClientOperations,
  RuntimeClientTransportPolicy,
  RuntimeClientTransportWire,
} from '../../gen/ts/runtime-client-transport.js'
import { jcs } from '../jcs.js'
import { validateRuntimeErrorDetail } from './artifacts.js'
import { canonicalJsonDigest } from './jcs-digest.js'
import type {
  ArtifactDownloadMetadata,
  ClientArtifactOpenStreamRequest,
  ClientArtifactRangeMetadata,
  ClientArtifactReadRangeRequest,
  ClientArtifactStreamMetadata,
  ClientArtifactStreamStatusRequest,
  ClientArtifactStreamStatusResult,
  ClientBootstrapResult,
  ClientCallHeader,
  ClientCatalogPageResult,
  ClientCommandReply,
  ClientCommandRequest,
  ClientQueryReply,
  ClientQueryRequest,
  ClientTransportFrame,
  ClientTransportRequestFrame,
  DataRef,
  RuntimeError,
  TransportAuthenticationEvidence,
  TransportCredentialEnvelope,
  ValidationResult,
} from './public.js'
import { RuntimeSchemaRefs, validateRuntime } from './public.js'

export type { ClientJsonOperation, ClientOperationTypes }
export { RuntimeClientOperations, RuntimeClientTransportPolicy, RuntimeClientTransportWire }

const refuse = <T>(message: string): ValidationResult<T> => ({
  ok: false,
  errors: [{ path: '', code: 'OTHER', message }],
})

/** Validates a business payload, without granting authorization or accepting a command. */
export function validateClientOperationInput<K extends ClientJsonOperation>(
  operation: K,
  value: unknown,
): ValidationResult<ClientOperationTypes[K]['input']> {
  const entry = Object.hasOwn(RuntimeClientOperations, operation)
    ? RuntimeClientOperations[operation]
    : undefined
  if (!entry || (entry.kind !== 'query' && entry.kind !== 'command'))
    return refuse('unknown JSON client operation')
  return validateRuntime(entry.input, value) as ValidationResult<ClientOperationTypes[K]['input']>
}

/** Schema-derived paths stop before opaque business values and validate only typed error leaves. */
function validClientOutputErrors(output: string, value: unknown): boolean {
  const slots: Readonly<Record<string, readonly (readonly string[])[]>> = RuntimeClientErrorSlots
  const paths = slots[output]
  if (!paths) return false
  const walk = (node: unknown, path: readonly string[]): boolean => {
    if (node === null || node === undefined) return true
    const [key, ...rest] = path
    if (key === undefined) return validateRuntimeErrorDetail(node).ok
    if (typeof node !== 'object') return false
    if (key === '*') return Object.values(node).every((child) => walk(child, rest))
    if (!Object.hasOwn(node, key)) return true
    return walk((node as Record<string, unknown>)[key], rest)
  }
  return paths.every((path) => walk(value, path))
}

/** Both the operation and current communication header must match the original call. */
export function validateClientReply(
  request: ClientQueryRequest | ClientCommandRequest,
  value: unknown,
): ValidationResult<ClientQueryReply | ClientCommandReply> {
  const query = validateClientQueryRequest(request)
  const call = query.ok ? query : validateClientCommandRequest(request)
  if (!call.ok) return refuse('invalid original client call')
  const entry = RuntimeClientOperations[call.value.call.operation]
  const result = validateRuntime(entry.kind === 'query' ? 'ClientQueryReply' : 'ClientCommandReply', value)
  if (!result.ok) return result
  if (
    result.value.reply.operation !== call.value.call.operation ||
    jcs(result.value.header) !== jcs(call.value.header)
  )
    return refuse('client reply belongs to a different call or session')
  if (
    call.value.call.operation === 'transport.streamStatus' &&
    result.value.reply.operation === 'transport.streamStatus'
  ) {
    const status = validateClientStreamStatus(call.value.call.input, result.value.reply.value)
    if (!status.ok) return refuse('client stream status belongs to a different reader or interval')
  }
  if (!validClientOutputErrors(entry.output, result.value.reply.value))
    return refuse('invalid typed owner error classification')
  return result
}

/** Both routing and nested management headers identify the same call, never authenticate it. */
export function validateClientQueryRequest(value: unknown): ValidationResult<ClientQueryRequest> {
  const request = validateRuntime('ClientQueryRequest', value)
  if (!request.ok) return request
  const call = request.value.call
  if (
    (call.operation === 'transport.catalogStatus' || call.operation === 'transport.streamStatus') &&
    jcs(call.input.header) !== jcs(request.value.header)
  )
    return refuse('management query headers differ')
  return request
}

export function validateClientCommandRequest(value: unknown): ValidationResult<ClientCommandRequest> {
  return validateRuntime('ClientCommandRequest', value)
}

/** Wrong-kind operation names and all matching-call checks apply equally to WS uplinks. */
export function validateClientTransportRequestFrame(
  value: unknown,
): ValidationResult<ClientTransportRequestFrame> {
  const frame = validateRuntime('ClientTransportRequestFrame', value)
  if (!frame.ok) return frame
  const request =
    frame.value.kind === 'query'
      ? validateClientQueryRequest(frame.value.request)
      : validateClientCommandRequest(frame.value.request)
  return request.ok ? frame : refuse('invalid websocket client call')
}

/** Page completeness, combined item count and schema dependencies share one generated policy. */
export function validateClientCatalogPage(
  value: unknown,
  requestedLimit: number,
): ValidationResult<ClientCatalogPageResult> {
  const policy = RuntimeClientTransportPolicy
  if (
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > policy.maxCatalogPageLimit ||
    Object.is(requestedLimit, -0)
  )
    return refuse('invalid catalog page limit')
  const result = validateRuntime('ClientCatalogPageResult', value)
  if (!result.ok) return result
  const page = result.value
  if (
    page.modules.length + page.domainSchemas.length > requestedLimit ||
    (page.nextCursor === null) !== page.complete
  )
    return refuse('incomplete or oversized catalog page')
  const modules = new Set<string>()
  const schemas = new Map<string, string>()
  for (const schema of page.domainSchemas) {
    const key = `${schema.typeId}\0${schema.revision}`
    if (schemas.has(key)) return refuse('duplicate catalog schema')
    schemas.set(key, schema.digest)
  }
  for (const module of page.modules) {
    if (modules.has(module.moduleId)) return refuse('duplicate catalog module')
    modules.add(module.moduleId)
    for (const schema of module.schemas) {
      if (schemas.get(`${schema.typeId}\0${schema.revision}`) !== schema.digest)
        return refuse('catalog module is missing its locked schema')
    }
  }
  return result
}

/** Keeps binary bytes outside JSON while checking the authorized range request's format. */
export function validateClientBinaryRequest(
  kind: 'range',
  value: unknown,
): ValidationResult<ClientArtifactReadRangeRequest>
export function validateClientBinaryRequest(
  kind: 'stream',
  value: unknown,
): ValidationResult<ClientArtifactOpenStreamRequest>
export function validateClientBinaryRequest(
  kind: 'range' | 'stream',
  value: unknown,
): ValidationResult<ClientArtifactReadRangeRequest | ClientArtifactOpenStreamRequest> {
  if (kind !== 'range' && kind !== 'stream') return refuse('invalid binary request kind')
  const result = validateRuntime(
    kind === 'range' ? 'ClientArtifactReadRangeRequest' : 'ClientArtifactOpenStreamRequest',
    value,
  )
  if (!result.ok) return result
  const request = result.value.input
  if (
    'length' in request &&
    (request.length < 1 ||
      request.length > RuntimeClientTransportPolicy.maxRangeBytes ||
      !Number.isSafeInteger(request.offset + request.length))
  )
    return refuse('invalid binary range')
  return result
}

/** Bootstrap's implicit first-page limit is fixed, never selected from client claims. */
export function validateClientBootstrap(value: unknown): ValidationResult<ClientBootstrapResult> {
  const result = validateRuntime('ClientBootstrapResult', value)
  if (!result.ok || !('welcome' in result.value)) return result
  const { welcome, catalogPage } = result.value
  const page = validateClientCatalogPage(
    {
      catalogRevision: welcome.catalogRevision,
      modules: welcome.modules,
      domainSchemas: welcome.domainSchemas,
      ...catalogPage,
    },
    RuntimeClientTransportPolicy.defaultCatalogPageLimit,
  )
  return page.ok ? result : refuse('invalid bootstrap catalog first page')
}

/** Pure routing classification; validation grants neither admission nor authorization. */
export function clientCommandQuotaClass(value: unknown): ValidationResult<'work' | 'control'> {
  const request = validateRuntime('ClientCommandRequest', value)
  if (!request.ok) return request
  const operation = RuntimeClientOperations[request.value.call.operation]
  if (operation.quotaClass === 'control') return { ok: true, value: 'control' }
  if (request.value.call.operation === 'control.submit')
    return { ok: true, value: request.value.call.input.command.kind === 'cancel' ? 'control' : 'work' }
  return { ok: true, value: 'work' }
}

/** Bytes and final digest describe exactly the interval actually delivered. */
export function validateClientStreamStatus(
  request: ClientArtifactStreamStatusRequest,
  value: unknown,
): ValidationResult<ClientArtifactStreamStatusResult> {
  const call = validateRuntime('ClientArtifactStreamStatusRequest', request)
  const result = validateRuntime('ClientArtifactStreamStatusResult', value)
  if (!call.ok) return refuse('invalid stream status request')
  if (!result.ok) return result
  if (
    (result.value.state === 'failed' || result.value.state === 'cancelled') &&
    !validateRuntimeErrorDetail(result.value.error).ok
  )
    return refuse('invalid stream failure classification')
  if (
    call.value.streamId !== result.value.streamId ||
    (result.value.bytes !== null && result.value.bytes > RuntimeClientTransportPolicy.maxArtifactBytes) ||
    (result.value.state === 'succeeded' && result.value.summary.bytes !== result.value.bytes)
  )
    return refuse('invalid stream terminal summary')
  return result
}

/** Decode schema-locked ephemeral input; trusted provenance/signature verification remains Host/C14. */
export function validateIdentityTransportRequest(value: unknown): ValidationResult<{
  credential: TransportCredentialEnvelope
  evidence: TransportAuthenticationEvidence
}> {
  const parsed = validateRuntime('IdentityAuthenticateRequest', value)
  if (!parsed.ok) return refuse('invalid transport authentication input')
  const decode = (ref: DataRef, name: 'TransportCredentialEnvelope' | 'TransportAuthenticationEvidence') => {
    const expected = RuntimeSchemaRefs[name]
    if (
      ref.kind !== 'inline' ||
      jcs(ref.schema) !== jcs(expected) ||
      ref.bytes !== new TextEncoder().encode(jcs(ref.value)).length ||
      ref.digest !== canonicalJsonDigest(ref.value)
    )
      return refuse('invalid ephemeral authentication reference')
    return validateRuntime(name, ref.value)
  }
  const credential = decode(parsed.value.credentialEnvelope, 'TransportCredentialEnvelope')
  const evidence = decode(parsed.value.transportEvidence, 'TransportAuthenticationEvidence')
  if (!credential.ok || !evidence.ok) return refuse('invalid typed authentication content')
  // Each call is narrowed separately to preserve the two schema-owned types.
  const token = validateRuntime('TransportCredentialEnvelope', credential.value)
  const proof = validateRuntime('TransportAuthenticationEvidence', evidence.value)
  if (!token.ok || !proof.ok) return refuse('invalid typed authentication content')
  return { ok: true, value: { credential: token.value, evidence: proof.value } }
}

const binaryMetadataNames = {
  range: 'ClientArtifactRangeMetadata',
  stream: 'ClientArtifactStreamMetadata',
  download: 'ArtifactDownloadMetadata',
} as const

/** Header serialization stays browser-compatible and does not transport credentials. */
export function encodeClientBinaryMetadata(
  kind: keyof typeof binaryMetadataNames,
  value: unknown,
): ValidationResult<string> {
  if (!Object.hasOwn(binaryMetadataNames, kind)) return refuse('unknown binary metadata kind')
  const result = validateRuntime(binaryMetadataNames[kind], value)
  if (!result.ok) return refuse('invalid binary metadata')
  const metadata = 'stream' in result.value ? result.value.stream : result.value
  if (
    metadata.totalBytes > RuntimeClientTransportPolicy.maxArtifactBytes ||
    metadata.offset > metadata.totalBytes ||
    ('bytes' in metadata &&
      (metadata.bytes > RuntimeClientTransportPolicy.maxRangeBytes ||
        !Number.isSafeInteger(metadata.offset + metadata.bytes) ||
        metadata.offset + metadata.bytes > metadata.totalBytes))
  )
    return refuse('invalid delivered binary interval')
  const bytes = new TextEncoder().encode(jcs(result.value))
  if (bytes.length > RuntimeClientTransportPolicy.maxBinaryMetadataBytes)
    return refuse('binary metadata exceeds header budget')
  return {
    ok: true,
    value: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, ''),
  }
}

export function decodeClientBinaryMetadata(
  kind: keyof typeof binaryMetadataNames,
  value: unknown,
): ValidationResult<ClientArtifactRangeMetadata | ClientArtifactStreamMetadata | ArtifactDownloadMetadata> {
  if (
    !Object.hasOwn(binaryMetadataNames, kind) ||
    typeof value !== 'string' ||
    value.length > Math.ceil((RuntimeClientTransportPolicy.maxBinaryMetadataBytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    return refuse('invalid binary metadata header')
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const parsed = validateRuntime(binaryMetadataNames[kind], JSON.parse(json))
    if (!parsed.ok) return parsed
    const encoded = encodeClientBinaryMetadata(kind, parsed.value)
    if (!encoded.ok || encoded.value !== value) return refuse('non-canonical binary metadata header')
    const metadata = 'stream' in parsed.value ? parsed.value.stream : parsed.value
    if (
      metadata.totalBytes > RuntimeClientTransportPolicy.maxArtifactBytes ||
      metadata.offset > metadata.totalBytes ||
      ('bytes' in metadata &&
        (metadata.bytes > RuntimeClientTransportPolicy.maxRangeBytes ||
          !Number.isSafeInteger(metadata.offset + metadata.bytes) ||
          metadata.offset + metadata.bytes > metadata.totalBytes))
    )
      return refuse('invalid delivered binary interval')
    return parsed
  } catch {
    return refuse('invalid binary metadata encoding')
  }
}

/** Actual HTTP Outcome parsing checks reserved error semantics, not only their wire structure. */
export function validateClientTransportResult(
  request: ClientQueryRequest | ClientCommandRequest,
  value: unknown,
): ValidationResult<
  { ok: true; value: ClientQueryReply | ClientCommandReply } | { ok: false; error: RuntimeError }
> {
  const query = validateClientQueryRequest(request)
  const call = query.ok ? query : validateClientCommandRequest(request)
  if (!call.ok) return refuse('invalid original client call')
  const json = validateRuntime('JsonValue', value)
  if (!json.ok || !json.value || typeof json.value !== 'object' || Array.isArray(json.value))
    return refuse('invalid client transport outcome')
  const outcome = json.value
  if (outcome.ok === true && Object.keys(outcome).sort().join(',') === 'ok,value') {
    const reply = validateClientReply(call.value, outcome.value)
    return reply.ok
      ? { ok: true, value: { ok: true, value: reply.value } }
      : refuse('invalid client transport reply')
  }
  if (outcome.ok === false && Object.keys(outcome).sort().join(',') === 'error,ok') {
    const error = validateRuntimeErrorDetail(outcome.error)
    return error.ok
      ? { ok: true, value: { ok: false, error: error.value } }
      : refuse('invalid client transport failure')
  }
  return refuse('invalid client transport outcome')
}

/** Current reader/call correlation and registered error classifications apply to push consumers. */
export function validateClientTransportFrame(
  header: ClientCallHeader,
  value: unknown,
): ValidationResult<ClientTransportFrame> {
  const expected = validateRuntime('ClientCallHeader', header)
  const frame = validateRuntime('ClientTransportFrame', value)
  if (!expected.ok) return refuse('invalid original transport header')
  if (!frame.ok) return frame
  const actual = frame.value.kind === 'reply' ? frame.value.result.header : frame.value.header
  if (jcs(actual) !== jcs(expected.value)) return refuse('transport frame belongs to another call or session')
  if (
    frame.value.kind === 'reply' &&
    !validClientOutputErrors(
      RuntimeClientOperations[frame.value.result.reply.operation].output,
      frame.value.result.reply.value,
    )
  )
    return refuse('invalid typed reply error classification')
  if (frame.value.kind === 'error' && !validateRuntimeErrorDetail(frame.value.error).ok)
    return refuse('invalid transport error classification')
  if (
    frame.value.kind === 'subscription' &&
    frame.value.frame.kind === 'error' &&
    !validateRuntimeErrorDetail(frame.value.frame.payload).ok
  )
    return refuse('invalid subscription error classification')
  return frame
}

/** A reply frame is usable only for its registered original operation and session. */
export function validateClientTransportReplyFrame(
  request: ClientQueryRequest | ClientCommandRequest,
  value: unknown,
): ValidationResult<ClientTransportFrame> {
  const query = validateClientQueryRequest(request)
  const call = query.ok ? query : validateClientCommandRequest(request)
  if (!call.ok) return refuse('invalid original websocket call')
  const frame = validateClientTransportFrame(call.value.header, value)
  if (!frame.ok) return frame
  if (frame.value.kind !== 'reply' && frame.value.kind !== 'error')
    return refuse('unexpected websocket call result frame')
  if (frame.value.kind === 'reply' && !validateClientReply(call.value, frame.value.result).ok)
    return refuse('websocket reply belongs to another operation or reader')
  return frame
}
