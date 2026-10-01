import type { JsonSchemaDoc } from './gen-core.js'

type Json = Record<string, unknown>
const object = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const methods = [
  'bootstrap',
  'clientQuery',
  'clientCommand',
  'catalogPage',
  'subscribe',
  'readSubscription',
  'closeSubscription',
  'catalogStatus',
  'streamStatus',
] as const

/** Physical paths and handler identities come from one schema-owned table. */
export function validateClientTransportWire(
  document: JsonSchemaDoc,
  catalog: Json,
  names: ReadonlySet<string>,
): Json {
  const wire = document['x-client-transport-wire']
  if (
    !object(wire) ||
    !object(wire.routes) ||
    wire.feature !== 'client-transport-wire.v2' ||
    wire.wireMajor !== 2 ||
    wire.jsonMime !== 'application/json' ||
    wire.binaryMime !== 'application/octet-stream' ||
    wire.metadataHeader !== 'X-Agh-Runtime-Metadata' ||
    wire.metadataEncoding !== 'base64url-jcs'
  )
    throw new Error('invalid client transport wire policy')
  if (
    Object.keys(wire).sort().join(',') !==
    'binaryMime,feature,jsonMime,metadataEncoding,metadataHeader,routes,wireMajor'
  )
    throw new Error('unknown client wire policy field')
  const expected = [...methods, 'readRange', 'openStream', 'download', 'websocket'].sort()
  if (Object.keys(wire.routes).sort().join(',') !== expected.join(','))
    throw new Error('incomplete client transport routes')
  const paths = new Set<string>()
  const transport = catalog['agh.transport']
  if (!object(transport) || !object(transport.methods)) throw new Error('missing transport owner')
  for (const [name, route] of Object.entries(wire.routes)) {
    if (
      !object(route) ||
      typeof route.path !== 'string' ||
      paths.has(route.path) ||
      typeof route.input !== 'string' ||
      !names.has(route.input) ||
      typeof route.output !== 'string' ||
      !names.has(route.output)
    )
      throw new Error(`invalid transport route ${name}`)
    const fields = (methods as readonly string[]).includes(name)
      ? ['method', 'path', 'contract', 'backendMethod', 'input', 'output', 'responseMime', 'quotaClass']
      : name === 'websocket'
        ? ['method', 'path', 'subprotocol', 'input', 'output', 'responseMime', 'quotaClass']
        : name === 'download'
          ? ['method', 'path', 'operation', 'input', 'output', 'responseMime', 'quotaClass', 'query', 'range']
          : ['method', 'path', 'operation', 'input', 'output', 'responseMime', 'quotaClass']
    if (Object.keys(route).sort().join(',') !== fields.sort().join(','))
      throw new Error(`unknown transport route field ${name}`)
    paths.add(route.path)
    if ((methods as readonly string[]).includes(name)) {
      const backend = transport.methods[name]
      if (
        !object(backend) ||
        route.contract !== 'agh.transport' ||
        route.backendMethod !== name ||
        route.path !== `/api/runtime/client/${name}` ||
        route.method !== 'POST' ||
        route.input !== backend.input ||
        route.output !== backend.output ||
        route.responseMime !== wire.jsonMime ||
        backend.sameAttemptBrokerAllowed === true ||
        route.quotaClass !==
          (name === 'closeSubscription' ? 'control' : name === 'clientCommand' ? 'operation' : 'read')
      )
        throw new Error(`mismatched transport owner route ${name}`)
    } else if (name === 'websocket') {
      if (
        route.path !== '/api/runtime/client/stream' ||
        route.method !== 'GET' ||
        route.subprotocol !== 'agh.runtime.client.v2' ||
        route.input !== 'ClientTransportRequestFrame' ||
        route.output !== 'ClientTransportFrame' ||
        route.responseMime !== wire.jsonMime ||
        route.quotaClass !== 'operation'
      )
        throw new Error('invalid websocket transport route')
    } else if (name === 'download') {
      if (
        route.path !== '/api/runtime/artifact/download/{ticketId}' ||
        route.method !== 'GET' ||
        route.operation !== 'artifact.redeemDownload' ||
        route.input !== 'ArtifactRedeemDownloadRequest' ||
        route.output !== 'ArtifactDownloadMetadata' ||
        route.range !== 'single-open-ended' ||
        !Array.isArray(route.query) ||
        route.query.join(',') !== 'nonce' ||
        route.responseMime !== wire.binaryMime ||
        route.quotaClass !== 'read'
      )
        throw new Error('invalid download transport route')
    } else {
      const operations = document['x-client-operations']
      const operation = object(operations) ? operations[`artifact.${name}`] : undefined
      if (
        !object(operation) ||
        operation.kind !== 'binary' ||
        route.operation !== `artifact.${name}` ||
        route.path !== `/api/runtime/artifact/${name}` ||
        route.method !== 'POST' ||
        route.input !==
          (name === 'readRange' ? 'ClientArtifactReadRangeRequest' : 'ClientArtifactOpenStreamRequest') ||
        route.output !==
          (name === 'readRange' ? 'ClientArtifactRangeMetadata' : 'ClientArtifactStreamMetadata') ||
        route.responseMime !== wire.binaryMime ||
        route.quotaClass !== 'read'
      )
        throw new Error(`invalid binary transport route ${name}`)
    }
  }
  const identity = document['x-identity-transport-schemas']
  if (
    !object(identity) ||
    identity.credentialEnvelope !== 'TransportCredentialEnvelope' ||
    identity.transportEvidence !== 'TransportAuthenticationEvidence' ||
    identity.proof !== 'TransportEvidenceProof' ||
    identity.moduleBinding !== 'ClientModuleCredentialBinding' ||
    identity.requiresVerifiedModuleLoad !== true ||
    identity.cookieName !== 'agh-runtime-credential' ||
    identity.hostOnlyEvidence !== true ||
    identity.downloadTicketNonceIsIdentity !== false ||
    identity.publicOwnerToken !== 'non-secret-renderer-generation-handle' ||
    !Array.isArray(identity.credentialChannels) ||
    identity.credentialChannels.join(',') !== 'authorization-bearer,httponly-cookie' ||
    !Array.isArray(identity.forbiddenCredentialLocations) ||
    identity.forbiddenCredentialLocations.join(',') !== 'url,business-json'
  )
    throw new Error('invalid identity transport schema binding')
  return wire
}

/** Derive only declared RuntimeError leaves, never inspect opaque business JSON keys. */
export function clientErrorSlots(graph: JsonSchemaDoc, name: string): string[][] {
  const slots = new Map<string, string[]>()
  const walk = (schema: unknown, path: string[], stack: ReadonlySet<string>): void => {
    if (!object(schema)) return
    if (typeof schema.$ref === 'string') {
      const target = schema.$ref.split('/').at(-1) ?? ''
      if (target === 'RuntimeError') {
        slots.set(JSON.stringify(path), path)
        return
      }
      if (['JsonValue', 'DataRef', 'BytesRef', 'SchemaRef'].includes(target) || stack.has(target)) return
      const definition = graph.$defs?.[target]
      if (!definition) throw new Error(`unresolved client error slot schema ${target}`)
      walk(definition, path, new Set([...stack, target]))
      return
    }
    for (const keyword of ['anyOf', 'oneOf', 'allOf'])
      if (Array.isArray(schema[keyword])) for (const branch of schema[keyword]) walk(branch, path, stack)
    if (object(schema.properties))
      for (const [key, value] of Object.entries(schema.properties)) walk(value, [...path, key], stack)
    if (schema.items) walk(schema.items, [...path, '*'], stack)
    if (object(schema.additionalProperties)) walk(schema.additionalProperties, [...path, '*'], stack)
  }
  walk({ $ref: `#/$defs/${name}` }, [], new Set())
  return [...slots.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
