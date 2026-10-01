import { clientErrorSlots, validateClientTransportWire } from './gen-client-transport-wire.js'
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
  quotaClass?: 'work' | 'control' | 'conditional-control'
  controlPredicate?: { field: 'command.kind'; equals: 'cancel' }
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
  'quotaClass',
  'controlPredicate',
])

export const APPROVED_CLIENT_OPERATIONS = [
  'conversation.create',
  'conversation.open',
  'conversation.history',
  'conversation.submit',
  'conversation.cancel',
  'conversation.status',
  'domain.query',
  'domain.submit',
  'domain.commandStatus',
  'control.read',
  'control.submit',
  'control.status',
  'budget.read',
  'permission.listGrants',
  'permission.revokeGrant',
  'jobs.enqueue',
  'jobs.poll',
  'jobs.cancel',
  'jobs.create',
  'jobs.update',
  'jobs.inspect',
  'jobs.cancelDefinition',
  'jobs.commandStatus',
  'interaction.pending',
  'interaction.read',
  'interaction.respond',
  'interaction.formLink',
  'interaction.responseStatus',
  'approval.read',
  'approval.respond',
  'approval.formLink',
  'approval.responseStatus',
  'artifact.describe',
  'artifact.openDownload',
  'artifact.readRange',
  'artifact.openStream',
  'artifact.followDownload',
  'transport.catalogStatus',
  'transport.streamStatus',
  'conversation.list',
] as const

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
    if (operation.kind !== 'local' && operation.requiredFeature !== 'client-transport-wire.v2')
      throw new Error(`unnegotiated client wire operation ${name}`)
    if (!(APPROVED_CLIENT_OPERATIONS as readonly string[]).includes(name))
      throw new Error(`unapproved client operation ${name}`)
    const controls = ['conversation.cancel', 'jobs.cancel', 'jobs.cancelDefinition', 'permission.revokeGrant']
    if (operation.kind === 'command') {
      const expected =
        name === 'control.submit' ? 'conditional-control' : controls.includes(name) ? 'control' : 'work'
      if (
        operation.quotaClass !== expected ||
        (name === 'control.submit'
          ? JSON.stringify(operation.controlPredicate) !==
            JSON.stringify({ field: 'command.kind', equals: 'cancel' })
          : operation.controlPredicate !== undefined)
      )
        throw new Error(`invalid client control quota ${name}`)
    } else if (operation.quotaClass !== undefined || operation.controlPredicate !== undefined)
      throw new Error(`unexpected client control quota ${name}`)
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
  for (const approved of APPROVED_CLIENT_OPERATIONS) {
    if (approved === 'conversation.list' && !/\blist\s*\(/.test(String(client.ShellConversationClient)))
      continue
    if (!Object.hasOwn(result, approved)) throw new Error(`missing approved client operation ${approved}`)
  }
  for (const name of new Set([
    ...Object.values(result).map((entry) => entry.localInterface),
    'ClientTransportClient',
  ])) {
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
  graph: JsonSchemaDoc = document,
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
    'controlMaxConcurrentPerWorkspace,controlMaxRequestsPerPrincipalPerMinute,controlWindowMs,defaultCatalogPageLimit,downloadTicketTtlMs,eof,maxArtifactBytes,maxBootstrapMessageUtf8Bytes,maxBootstrapRejectedBytes,maxCatalogPageLimit,maxBinaryMetadataBytes,maxJsonBytes,maxRangeBytes,maxReaderQueueBytes,maxReaderQueueFrames,maxSupportedProtocols,readerIdleTimeoutMs,streamStatusRetentionMs,maxStreamsPerWorkspace'
  if (
    Object.keys(policy).sort().join(',') !== exact.split(',').sort().join(',') ||
    (policy.defaultCatalogPageLimit as number) > (policy.maxCatalogPageLimit as number) ||
    policy.controlMaxConcurrentPerWorkspace !== 32 ||
    policy.controlMaxRequestsPerPrincipalPerMinute !== 120 ||
    policy.controlWindowMs !== 60_000 ||
    policy.streamStatusRetentionMs !== 300_000 ||
    policy.maxStreamsPerWorkspace !== 256 ||
    policy.maxBinaryMetadataBytes !== 8192
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
  const wire = validateClientTransportWire(document, catalog, wireNames)
  const json = Object.entries(operations).filter(([, operation]) =>
    ['query', 'command'].includes(operation.kind),
  )
  const errorSlots = Object.fromEntries(
    [...new Set([...json.map(([, operation]) => operation.output), 'ClientArtifactStreamStatusResult'])].map(
      (name) => [name, clientErrorSlots(graph, name)],
    ),
  )
  const clientNames = [...new Set(json.map(([, operation]) => operation.localInterface))].sort()
  const consumer = `${header}import type { ${clientNames.join(', ')} } from '@agnes/extension-api/client'\nimport type { Outcome } from '@agnes/extension-api/runtime'\nimport type { ClientOperationTypes } from '@agnes/protocol/runtime'\nexport async function consumeGeneratedClientSurface(clients: { ${clientNames.map((name) => `${name}: ${name}`).join('; ')} }, inputs: { [K in keyof ClientOperationTypes]: ClientOperationTypes[K]['input'] }): Promise<void> {\n${json
    .map(([name, operation]) => {
      const input = `inputs['${name}']`
      const args =
        operation.localMethod === 'describe'
          ? `${input}.artifactId, ${input}.version`
          : operation.localMethod === 'formLink'
            ? `${input}.interactionId, ${input}.expectedVersion`
            : input
      return `  const ${name.replaceAll('.', '_')}: Outcome<ClientOperationTypes['${name}']['output']> = await clients.${operation.localInterface}.${operation.localMethod}(${args}); void ${name.replaceAll('.', '_')}`
    })
    .join('\n')}\n}\n`
  return {
    '../extension-api/test/runtime/generated-client-transport.compile.ts': consumer,
    'gen/ts/runtime-client-transport.ts': `${header}import type * as Wire from './runtime-public.js'\nfunction freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }\nexport const RuntimeClientOperations = freeze(${JSON.stringify(operations, null, 2)} as const)\nexport const RuntimeClientTransportPolicy = freeze(${JSON.stringify(policy, null, 2)} as const)\nexport const RuntimeClientTransportWire = freeze(${JSON.stringify(wire, null, 2)} as const)\nexport const RuntimeClientErrorSlots = freeze(${JSON.stringify(errorSlots, null, 2)} as const)\nexport interface ClientOperationTypes {\n${json.map(([name, operation]) => `  '${name}': { input: Wire.${operation.input}; output: Wire.${operation.output} }`).join('\n')}\n}\nexport type ClientJsonOperation = keyof ClientOperationTypes\n`,
  }
}
