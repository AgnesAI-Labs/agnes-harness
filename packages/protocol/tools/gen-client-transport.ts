import type { JsonSchemaDoc } from './gen-core.js'

type Json = Record<string, unknown>
export type ClientOperation = {
  localInterface: string
  localMethod: string
  kind: 'query' | 'command' | 'binary' | 'local'
  input: string
  output: string
  backendContract?: string
  backendMethod?: string
  backendKind?: string
  backendLocalInterface?: string
  backendInput?: string
  backendOutput?: string
  hostFields?: string[]
  wrapField?: string
  transform?: string
  identityField?: string
  statusOperation?: string
  requiredFeature?: string
  requiredBackendFeature?: string
  expectedInteractionKind?: string
}
const object = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const header = '// generated from runtime client metadata — do not edit\n'
const keys = new Set([
  'localInterface',
  'localMethod',
  'kind',
  'input',
  'output',
  'backendContract',
  'backendMethod',
  'backendKind',
  'backendLocalInterface',
  'backendInput',
  'backendOutput',
  'hostFields',
  'wrapField',
  'transform',
  'identityField',
  'statusOperation',
  'requiredFeature',
  'requiredBackendFeature',
  'expectedInteractionKind',
])

/** Verify the complete public client surface against its selected owner catalog and Local API. */
export function validateClientOperations(
  document: JsonSchemaDoc,
  local: Json,
  catalog: Json,
  wireNames: ReadonlySet<string>,
): Record<string, ClientOperation> {
  const raw = document['x-client-operations']
  if (!object(raw)) throw new Error('missing client operations')
  const sections = local['x-local-api']
  if (!object(sections) || !object(sections.client) || !object(sections.runtime))
    throw new Error('missing client Local API')
  const client = sections.client
  const runtime = sections.runtime
  const result: Record<string, ClientOperation> = {}
  const covered = new Set<string>()
  const counts: Record<string, number> = { query: 0, command: 0, binary: 0, local: 0 }
  for (const [name, value] of Object.entries(raw)) {
    if (!object(value) || Object.keys(value).some((key) => !keys.has(key)))
      throw new Error(`invalid client operation ${name}`)
    const operation = value as unknown as ClientOperation
    const identity = `${operation.localInterface}.${operation.localMethod}`
    const declaration = client[operation.localInterface]
    if (
      typeof declaration !== 'string' ||
      !new RegExp(`\\b${operation.localMethod}\\s*\\(`).test(declaration) ||
      covered.has(identity)
    )
      throw new Error(`missing or duplicate client Local method ${identity}`)
    covered.add(identity)
    if (!Object.hasOwn(counts, operation.kind) || !wireNames.has(operation.input))
      throw new Error(`invalid client operation input ${name}`)
    counts[operation.kind] = (counts[operation.kind] ?? 0) + 1
    if (operation.kind === 'local') {
      if (
        operation.output !== 'void' ||
        Object.keys(value).some(
          (key) => !['localInterface', 'localMethod', 'kind', 'input', 'output'].includes(key),
        )
      )
        throw new Error(`invalid client navigation ${name}`)
    } else {
      const owner = catalog[operation.backendContract ?? '']
      const methods = object(owner) && object(owner.methods) ? owner.methods : {}
      if (operation.backendLocalInterface) {
        const method = methods[operation.backendMethod ?? '']
        if (
          !object(method) ||
          method.local !== true ||
          method.clientOnly === true ||
          method.kind !== operation.backendKind ||
          method.localInterface !== operation.backendLocalInterface ||
          method.localMethod !== operation.backendMethod ||
          method.requiredFeature !== operation.requiredBackendFeature
        )
          throw new Error(`invalid client Local catalog mapping ${name}`)
        const port = runtime[operation.backendLocalInterface]
        if (typeof port !== 'string' || !new RegExp(`\\b${operation.backendMethod}\\s*\\(`).test(port))
          throw new Error(`missing client companion port ${name}`)
        if (operation.kind === 'binary' && typeof runtime[operation.output] !== 'string')
          throw new Error(`missing client binary result ${name}`)
      } else {
        const method = methods[operation.backendMethod ?? '']
        if (
          !object(method) ||
          method.local === true ||
          method.kind !== operation.backendKind ||
          method.input !== (operation.backendInput ?? operation.input) ||
          method.output !== (operation.backendOutput ?? operation.output) ||
          method.sameAttemptBrokerAllowed === true
        )
          throw new Error(`invalid client backend mapping ${name}`)
      }
      if (operation.transform === 'equivalent-payload') {
        for (const [a, b] of [
          [operation.input, operation.backendInput],
          [operation.output, operation.backendOutput],
        ]) {
          if (!a || !b || JSON.stringify(document.$defs?.[a]) !== JSON.stringify(document.$defs?.[b]))
            throw new Error(`non-equivalent client payload ${name}`)
        }
      }
      if (operation.kind !== 'binary' && !wireNames.has(operation.output))
        throw new Error(`unknown client response ${name}`)
      if (operation.wrapField) {
        if (operation.wrapField !== 'input' || operation.hostFields?.join(',') !== 'requestId')
          throw new Error(`invalid Host wrapper metadata ${name}`)
        const wrapper = document.$defs?.[operation.backendInput ?? '']
        const props = object(wrapper) && object(wrapper.properties) ? wrapper.properties : {}
        const wrapped = props.input
        const requestId = props.requestId
        if (
          wrapper?.additionalProperties !== false ||
          !Array.isArray(wrapper.required) ||
          wrapper.required.slice().sort().join(',') !== 'input,requestId' ||
          Object.keys(props).sort().join(',') !== 'input,requestId' ||
          !object(wrapped) ||
          wrapped.$ref !== `#/$defs/${operation.input}` ||
          !object(requestId) ||
          requestId.$ref !== 'prototype.json#/$defs/Id'
        )
          throw new Error(`invalid Host wrapper schema ${name}`)
      }
    }
    result[name] = operation
  }
  for (const kind of ['query', 'command'] as const) {
    const stem = `Client${kind === 'query' ? 'Query' : 'Command'}`
    for (const [suffix, field] of [
      ['Call', 'input'],
      ['Value', 'output'],
    ] as const) {
      const union = document.$defs?.[stem + suffix]?.anyOf
      if (!Array.isArray(union) || union.length !== counts[kind])
        throw new Error('client union does not match its operation metadata')
      const branches = new Set<string>()
      for (const branch of union) {
        const props = object(branch) && object(branch.properties) ? branch.properties : {}
        const discriminant = props.operation
        const payload = props[field === 'input' ? 'input' : 'value']
        const name = object(discriminant) ? discriminant.const : undefined
        const operation = typeof name === 'string' ? result[name] : undefined
        const type = operation?.[field]
        const expectedRef = type && `${document.$defs?.[type] ? '' : 'prototype.json'}#/$defs/${type}`
        if (
          !object(branch) ||
          branch.additionalProperties !== false ||
          !operation ||
          operation.kind !== kind ||
          branches.has(name as string) ||
          !object(payload) ||
          payload.$ref !== expectedRef
        )
          throw new Error('client union has an unknown or mismatched payload')
        branches.add(name as string)
      }
    }
  }
  if (counts.query !== 18 || counts.command !== 16 || counts.binary !== 2 || counts.local !== 1)
    throw new Error('client operation surface is incomplete')
  for (const name of new Set(Object.values(result).map((entry) => entry.localInterface))) {
    const declaration = client[name] as string
    const declared = [...declaration.matchAll(/\b(\w+)\s*\([^;{}]*\)\s*:/g)].map((match) => match[1])
    for (const method of declared) {
      if (!covered.has(`${name}.${method}`)) throw new Error(`unmapped client Local method ${name}.${method}`)
    }
  }
  return result
}

/** Emit typed payload mappings from the same metadata that owns routing. */
export function generateClientTransportArtifacts(
  document: JsonSchemaDoc,
  local: Json,
  catalog: Json,
  wireNames: ReadonlySet<string>,
): Record<string, string> {
  const operations = validateClientOperations(document, local, catalog, wireNames)
  const policy = document['x-client-transport-policy']
  if (
    !object(policy) ||
    policy.eof !== 'clamp' ||
    Object.values(policy).some(
      (value) =>
        value !== 'clamp' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0),
    )
  )
    throw new Error('invalid client transport policy')
  const exact =
    'defaultCatalogPageLimit,downloadTicketTtlMs,eof,maxArtifactBytes,maxBootstrapMessageUtf8Bytes,maxBootstrapRejectedBytes,maxCatalogPageLimit,maxJsonBytes,maxRangeBytes,maxReaderQueueBytes,maxReaderQueueFrames,maxSupportedProtocols,readerIdleTimeoutMs'
  if (
    Object.keys(policy).sort().join(',') !== exact ||
    (policy.defaultCatalogPageLimit as number) > (policy.maxCatalogPageLimit as number)
  )
    throw new Error('incomplete client transport policy')
  const rejected = document.$defs?.ClientBootstrapRejected
  const props = rejected?.properties as Json | undefined
  if (
    rejected?.['x-max-canonical-json-bytes'] !== policy.maxBootstrapRejectedBytes ||
    !object(props?.message) ||
    props.message['x-max-utf8-bytes'] !== policy.maxBootstrapMessageUtf8Bytes ||
    !object(props?.supportedProtocols) ||
    props.supportedProtocols.maxItems !== policy.maxSupportedProtocols
  )
    throw new Error('client bootstrap policy differs from its schema')
  const json = Object.entries(operations).filter(([, operation]) =>
    ['query', 'command'].includes(operation.kind),
  )
  return {
    'gen/ts/runtime-client-transport.ts': `${header}import type * as Wire from './runtime-public.js'\nfunction freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }\nexport const RuntimeClientOperations = freeze(${JSON.stringify(operations, null, 2)} as const)\nexport const RuntimeClientTransportPolicy = freeze(${JSON.stringify(policy, null, 2)} as const)\nexport interface ClientOperationTypes {\n${json.map(([name, operation]) => `  '${name}': { input: Wire.${operation.input}; output: Wire.${operation.output} }`).join('\n')}\n}\nexport type ClientJsonOperation = keyof ClientOperationTypes\n`,
  }
}
