import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { Ajv2020 as Ajv2020Class } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { jcs } from '../../src/jcs.js'
import type { ClientJsonOperation } from '../../src/runtime/index.js'
import {
  RuntimeClientOperations,
  RuntimeClientTransportPolicy,
  RuntimeMethodSchemaRefs,
  validateClientBinaryRequest,
  validateClientCatalogPage,
  validateClientOperationInput,
  validateClientReply,
  validateRuntime,
} from '../../src/runtime/index.js'
import {
  generateClientTransportArtifacts,
  validateClientOperations,
} from '../../tools/gen-client-transport.js'
import { loadRuntimeSchemaGraph, normalizeBrokerCatalog } from '../../tools/gen-runtime-full.js'

const directory = resolve(import.meta.dirname, '../../schema/runtime')
const graph = loadRuntimeSchemaGraph(directory)
const definitions = graph.document.$defs ?? {}
const local = JSON.parse(readFileSync(resolve(directory, 'local-api.json'), 'utf8'))
const catalog = normalizeBrokerCatalog(graph.publicDocument['x-service-catalog'])
const header = {
  negotiatedSession: 'session',
  clientInstanceId: 'client',
  catalogRevision: 1,
  callId: 'call',
}
const require = createRequire(import.meta.url)
const Ajv2020 = require('ajv/dist/2020.js').default as typeof Ajv2020Class
const ajv = new Ajv2020({ strict: false })
require('ajv-formats')(ajv)

/** Minimum structural fixtures from the independent JSON Schema oracle, not provider executions. */
function sample(schema: Record<string, unknown>): unknown {
  if (typeof schema.$ref === 'string')
    return sample(definitions[schema.$ref.slice(8)] as Record<string, unknown>)
  if ('const' in schema) return schema.const
  if (Array.isArray(schema.enum)) return schema.enum[0]
  const union = schema.anyOf ?? schema.oneOf
  if (Array.isArray(union)) {
    const nullable = union.find((branch) => branch.type === 'null')
    return sample(nullable ?? union[0])
  }
  if (schema.type === 'null') return null
  if (schema.type === 'boolean') return false
  if (schema.type === 'number' || schema.type === 'integer') return schema.minimum ?? 0
  if (schema.type === 'string') {
    if (schema.format === 'date-time') return '2026-10-01T00:00:00.000Z'
    const candidates = [
      'sample',
      'demo/schema@1',
      'a'.repeat(64),
      `sha256-${'a'.repeat(64)}`,
      'resume',
      '2026-10-01T00:00:00.000Z',
    ]
    return candidates.find((value) => !schema.pattern || new RegExp(String(schema.pattern)).test(value)) ?? ''
  }
  if (schema.type === 'array')
    return Array.from({ length: Number(schema.minItems ?? 0) }, () =>
      sample(schema.items as Record<string, unknown>),
    )
  if (schema.type === 'object') {
    const properties = schema.properties as Record<string, Record<string, unknown>>
    return Object.fromEntries(
      ((schema.required as string[]) ?? []).map((key) => [
        key,
        sample(properties[key] as Record<string, unknown>),
      ]),
    )
  }
  throw new Error(`unsupported fixture schema ${jcs(schema)}`)
}

const operations = Object.entries(RuntimeClientOperations).filter(
  ([, entry]) => entry.kind === 'query' || entry.kind === 'command',
)

describe('client transport static contract', () => {
  it('matches all 34 public JSON methods, both binary methods and local navigation', () => {
    expect(operations).toHaveLength(34)
    expect(Object.values(RuntimeClientOperations).filter((entry) => entry.kind === 'binary')).toHaveLength(2)
    expect(Object.values(RuntimeClientOperations).filter((entry) => entry.kind === 'local')).toHaveLength(1)
    expect(
      validateClientOperations(graph.publicDocument, local, catalog, new Set(Object.keys(definitions))),
    ).toEqual(RuntimeClientOperations)
    expect(Object.isFrozen(RuntimeClientTransportPolicy)).toBe(true)
    expect(Object.isFrozen(RuntimeClientOperations['artifact.openDownload'].hostFields)).toBe(true)
    expect(RuntimeClientTransportPolicy.eof).toBe('clamp')
  })

  it.each(operations)('%s has a real closed input and matching reply shape', (operation, entry) => {
    const input = sample(definitions[entry.input] as Record<string, unknown>)
    const oracle = ajv.compile({ $defs: definitions, $ref: `#/$defs/${entry.input}` })
    expect(oracle(input), JSON.stringify(oracle.errors)).toBe(true)
    expect(validateClientOperationInput(operation as ClientJsonOperation, input).ok).toBe(true)
    const request = { header, call: { operation, input } }
    const reply = {
      header,
      reply: { operation, value: sample(definitions[entry.output] as Record<string, unknown>) },
    }
    const parsed = validateRuntime(
      entry.kind === 'query' ? 'ClientQueryRequest' : 'ClientCommandRequest',
      request,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('invalid fixture')
    const validatedReply = validateClientReply(parsed.value, reply)
    expect(validatedReply.ok, JSON.stringify(validatedReply)).toBe(true)
    expect(validateClientReply(parsed.value, { ...reply, header: { ...header, callId: 'other' } }).ok).toBe(
      false,
    )
    expect(
      validateRuntime(entry.kind === 'query' ? 'ClientQueryRequest' : 'ClientCommandRequest', {
        ...request,
        actor: 'forged',
      }).ok,
    ).toBe(false)
  })

  it('rejects query/command and binary cross routing and mismatched responses', () => {
    const request = { header, call: { operation: 'interaction.read' as const, input: 'interaction' } }
    expect(validateRuntime('ClientCommandRequest', request).ok).toBe(false)
    expect(
      validateRuntime('ClientQueryRequest', { header, call: { operation: 'authorityFence', input: null } })
        .ok,
    ).toBe(false)
    expect(
      validateRuntime('ClientCommandRequest', {
        header,
        call: { operation: 'artifact.readRange', input: {} },
      }).ok,
    ).toBe(false)
    expect(
      validateClientReply(request, { header, reply: { operation: 'jobs.commandStatus', value: {} } }).ok,
    ).toBe(false)
    expect(
      validateClientReply(
        {
          get call() {
            throw new Error('getter must not run')
          },
          header,
        } as unknown as typeof request,
        null,
      ).ok,
    ).toBe(false)
  })

  it('refuses binary and navigation names from untyped JavaScript JSON calls', () => {
    const ranged = { artifactId: 'artifact', version: 1, offset: 0, length: 1 }
    const ticket = sample(definitions.ArtifactDownloadTicket as Record<string, unknown>)
    expect(Reflect.apply(validateClientOperationInput, undefined, ['artifact.readRange', ranged]).ok).toBe(
      false,
    )
    expect(
      Reflect.apply(validateClientOperationInput, undefined, ['artifact.followDownload', ticket]).ok,
    ).toBe(false)
    expect(Reflect.apply(validateClientOperationInput, undefined, ['not.anOperation', null]).ok).toBe(false)
  })

  it('rejects every routing or authority field on local navigation metadata', () => {
    for (const field of [
      'backendContract',
      'backendMethod',
      'backendKind',
      'backendInput',
      'backendOutput',
      'backendLocalInterface',
      'hostFields',
      'wrapField',
      'transform',
      'identityField',
      'statusOperation',
      'requiredFeature',
      'requiredBackendFeature',
      'expectedInteractionKind',
    ]) {
      const doc = structuredClone(graph.publicDocument)
      const operation = (doc['x-client-operations'] as Record<string, Record<string, unknown>>)[
        'artifact.followDownload'
      ]
      if (!operation) throw new Error('missing navigation fixture')
      operation[field] = field === 'hostFields' ? [] : 'forged'
      expect(
        () => generateClientTransportArtifacts(doc, local, catalog, new Set(Object.keys(definitions))),
        field,
      ).toThrow()
    }
  })

  it('rejects partial catalog completeness and counts modules plus schema refs', () => {
    const refs = Array.from({ length: 128 }, (_, i) => ({
      typeId: `demo/schema${i}@1`,
      revision: 1,
      digest: 'a'.repeat(64),
    }))
    const page = { catalogRevision: 1, modules: [], domainSchemas: refs, nextCursor: null, complete: true }
    expect(validateClientCatalogPage(page, 128).ok).toBe(true)
    expect(validateClientCatalogPage(page, 127).ok).toBe(false)
    expect(validateClientCatalogPage({ ...page, complete: false }, 128).ok).toBe(false)
    expect(validateClientCatalogPage({ ...page, domainSchemas: [refs[0], refs[0]] }, 128).ok).toBe(false)
    expect(validateClientCatalogPage(page, -0).ok).toBe(false)
    const module = sample(definitions.ClientModule as Record<string, unknown>) as { schemas: unknown[] }
    module.schemas = [refs[0]]
    expect(validateClientCatalogPage({ ...page, modules: [module], domainSchemas: [refs[0]] }, 2).ok).toBe(
      true,
    )
    expect(validateClientCatalogPage({ ...page, modules: [module], domainSchemas: [] }, 2).ok).toBe(false)
    expect(validateClientCatalogPage({ ...page, modules: [module], domainSchemas: refs }, 128).ok).toBe(false)
  })

  it('validates Host identities without exposing or accepting a client-injected identity', () => {
    const input = { artifactId: 'artifact', version: 1, disposition: 'inline' }
    expect(validateRuntime('ArtifactOpenDownloadRequest', { requestId: 'host-request', input }).ok).toBe(true)
    expect(validateRuntime('ArtifactOpenDownloadRequest', { input }).ok).toBe(false)
    expect(
      validateRuntime('ArtifactOpenDownloadRequest', { requestId: 'host-request', input, actor: 'forged' })
        .ok,
    ).toBe(false)
    expect(
      validateRuntime('ClientCommandRequest', {
        header,
        call: { operation: 'artifact.openDownload', input: { ...input, requestId: 'client-injected' } },
      }).ok,
    ).toBe(false)
    expect(
      validateRuntime('ClientCommandRequest', {
        header,
        call: {
          operation: 'interaction.formLink',
          input: { interactionId: 'interaction', expectedVersion: 0, requestId: 'client-injected' },
        },
      }).ok,
    ).toBe(false)
  })

  it('enforces UTF-8 bootstrap limits, fixed rejection shape and binary format limits', () => {
    const rejected = {
      mode: 'incompatible',
      reasonCode: 'protocol',
      message: '😀'.repeat(256),
      supportedProtocols: [],
    }
    expect(validateRuntime('ClientBootstrapResult', rejected).ok).toBe(true)
    expect(
      validateRuntime('ClientBootstrapResult', { ...rejected, message: `${rejected.message}a` }).ok,
    ).toBe(false)
    expect(
      validateRuntime('ClientBootstrapResult', { ...rejected, wireVersion: { major: 1, minor: 0 } }).ok,
    ).toBe(false)
    expect(
      validateRuntime('ClientBootstrapResult', {
        ...rejected,
        supportedProtocols: Array.from({ length: 17 }, () => ({ major: 1, minMinor: 0, maxMinor: 1 })),
      }).ok,
    ).toBe(false)
    const input = { artifactId: 'artifact', version: 1, offset: 0, length: 1048576 }
    expect(validateClientBinaryRequest('range', { header, input }).ok).toBe(true)
    for (const patch of [
      { length: 0 },
      { length: 1048577 },
      { offset: -0 },
      { offset: Number.MAX_SAFE_INTEGER },
    ])
      expect(validateClientBinaryRequest('range', { header, input: { ...input, ...patch } }).ok).toBe(false)
    expect(
      validateClientBinaryRequest('stream', { header, input: { artifactId: 'artifact', version: 1 } }).ok,
    ).toBe(true)
  })

  it('fails generation when a real mapping or Host wrapper contract is removed', () => {
    for (const change of [
      (doc: typeof graph.publicDocument) => {
        delete (doc['x-client-operations'] as Record<string, unknown>)['interaction.read']
      },
      (doc: typeof graph.publicDocument) => {
        const entry = (doc['x-client-operations'] as Record<string, Record<string, unknown>>)[
          'conversation.create'
        ]
        if (!entry) throw new Error('missing operation fixture')
        entry.backendMethod = 'lease'
      },
      (doc: typeof graph.publicDocument) => {
        const wrapper = doc.$defs?.ArtifactOpenDownloadRequest
        if (!wrapper) throw new Error('missing wrapper fixture')
        wrapper.required = ['input']
      },
    ]) {
      const doc = structuredClone(graph.publicDocument)
      change(doc)
      expect(() =>
        generateClientTransportArtifacts(doc, local, catalog, new Set(Object.keys(definitions))),
      ).toThrow()
    }
    expect(catalog['agh.artifacts']).toBeDefined()
    expect(RuntimeMethodSchemaRefs['agh.transport'].handshake).toBeDefined()
    expect(RuntimeMethodSchemaRefs['agh.transport'].connect).toBeDefined()
    expect(RuntimeMethodSchemaRefs['agh.transport'].command).toBeDefined()
  })
})
