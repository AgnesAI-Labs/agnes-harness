import type { ClientJsonOperation, ClientOperationTypes } from '../../gen/ts/runtime-client-transport.js'
import {
  RuntimeClientOperations,
  RuntimeClientTransportPolicy,
} from '../../gen/ts/runtime-client-transport.js'
import { jcs } from '../jcs.js'
import type {
  ClientArtifactOpenStreamRequest,
  ClientArtifactReadRangeRequest,
  ClientCatalogPageResult,
  ClientCommandReply,
  ClientCommandRequest,
  ClientQueryReply,
  ClientQueryRequest,
  ValidationResult,
} from './public.js'
import { validateRuntime } from './public.js'

export type { ClientJsonOperation, ClientOperationTypes }
export { RuntimeClientOperations, RuntimeClientTransportPolicy }

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

/** Both the operation and current communication header must match the original call. */
export function validateClientReply(
  request: ClientQueryRequest | ClientCommandRequest,
  value: unknown,
): ValidationResult<ClientQueryReply | ClientCommandReply> {
  const query = validateRuntime('ClientQueryRequest', request)
  const call = query.ok ? query : validateRuntime('ClientCommandRequest', request)
  if (!call.ok) return refuse('invalid original client call')
  const entry = RuntimeClientOperations[call.value.call.operation]
  const result = validateRuntime(entry.kind === 'query' ? 'ClientQueryReply' : 'ClientCommandReply', value)
  if (!result.ok) return result
  if (
    result.value.reply.operation !== call.value.call.operation ||
    jcs(result.value.header) !== jcs(call.value.header)
  )
    return refuse('client reply belongs to a different call or session')
  return result
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
