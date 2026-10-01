import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { Ajv2020 as Ajv2020Class } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { jcs } from '../../src/jcs.js'
import type { ClientJsonOperation, ClientWelcome, JsonValue } from '../../src/runtime/index.js'
import {
  canonicalJsonDigest,
  clientCommandQuotaClass,
  decodeClientBinaryMetadata,
  encodeClientBinaryMetadata,
  RuntimeClientOperations,
  RuntimeClientTransportPolicy,
  RuntimeClientTransportWire,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateClientBinaryRequest,
  validateClientBootstrap,
  validateClientCatalogPage,
  validateClientOperationInput,
  validateClientQueryRequest,
  validateClientReply,
  validateClientStreamStatus,
  validateClientTransportFrame,
  validateClientTransportReplyFrame,
  validateClientTransportRequestFrame,
  validateClientTransportResult,
  validateIdentityTransportRequest,
  validateRuntime,
} from '../../src/runtime/index.js'
import {
  APPROVED_CLIENT_OPERATIONS,
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
  it('matches the approved complete public operation set and real Local surface', () => {
    const approved = APPROVED_CLIENT_OPERATIONS.filter(
      (name) =>
        name !== 'conversation.list' ||
        /\blist\s*\(/.test(local['x-local-api'].client.ShellConversationClient),
    )
    expect(Object.keys(RuntimeClientOperations).sort()).toEqual([...approved].sort())
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
    if (operation === 'transport.catalogStatus' || operation === 'transport.streamStatus')
      (input as { header: typeof header }).header = header
    const request = { header, call: { operation, input } }
    const reply = {
      header,
      reply: { operation, value: sample(definitions[entry.output] as Record<string, unknown>) },
    }
    if (operation === 'transport.streamStatus')
      (reply.reply.value as { streamId: string }).streamId = (input as { streamId: string }).streamId
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
        () =>
          generateClientTransportArtifacts(
            doc,
            local,
            catalog,
            new Set(Object.keys(definitions)),
            graph.document,
          ),
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
        generateClientTransportArtifacts(
          doc,
          local,
          catalog,
          new Set(Object.keys(definitions)),
          graph.document,
        ),
      ).toThrow()
    }
    expect(catalog['agh.artifacts']).toBeDefined()
    expect(RuntimeMethodSchemaRefs['agh.transport'].handshake).toBeDefined()
    expect(RuntimeMethodSchemaRefs['agh.transport'].connect).toBeDefined()
    expect(RuntimeMethodSchemaRefs['agh.transport'].command).toBeDefined()
  })

  it('shares physical routes with declared owner methods and rejects metadata drift', () => {
    expect(RuntimeClientTransportWire.routes.clientCommand.path).toBe('/api/runtime/client/clientCommand')
    expect(RuntimeClientTransportWire.routes.download.path).toBe('/api/runtime/artifact/download/{ticketId}')
    for (const mutate of [
      (doc: typeof graph.publicDocument) => {
        ;(
          doc['x-client-transport-wire'] as { routes: { clientQuery: Record<string, unknown> } }
        ).routes.clientQuery.backendMethod = 'commit'
      },
      (doc: typeof graph.publicDocument) => {
        ;(
          doc['x-client-transport-wire'] as { routes: { openStream: Record<string, unknown> } }
        ).routes.openStream.responseMime = 'application/json'
      },
      (doc: typeof graph.publicDocument) => {
        ;(doc['x-identity-transport-schemas'] as Record<string, unknown>).hostOnlyEvidence = false
      },
      (doc: typeof graph.publicDocument) => {
        ;(doc['x-client-operations'] as { 'permission.revokeGrant': { quotaClass: string } })[
          'permission.revokeGrant'
        ].quotaClass = 'work'
      },
      (doc: typeof graph.publicDocument) => {
        ;(doc['x-client-operations'] as { 'control.submit': { controlPredicate: { equals: string } } })[
          'control.submit'
        ].controlPredicate.equals = 'prompt'
      },
    ]) {
      const doc = structuredClone(graph.publicDocument)
      mutate(doc)
      expect(() =>
        generateClientTransportArtifacts(
          doc,
          local,
          catalog,
          new Set(Object.keys(definitions)),
          graph.document,
        ),
      ).toThrow()
    }
  })

  it('validates websocket calls and catalog signals without accepting arbitrary remote authority', () => {
    const request = { header, call: { operation: 'interaction.read', input: 'interaction' } }
    expect(validateRuntime('ClientTransportRequestFrame', { kind: 'query', request }).ok).toBe(true)
    expect(validateRuntime('ClientTransportRequestFrame', { kind: 'command', request }).ok).toBe(false)
    expect(
      validateRuntime('ClientTransportRequestFrame', { kind: 'query', request, ownerToken: 'forged' }).ok,
    ).toBe(false)
    const status = { catalogRevision: 2, mode: 'reload-required', reasonCode: 'catalog_changed' }
    expect(validateRuntime('ClientTransportFrame', { kind: 'catalog-changed', header, status }).ok).toBe(true)
    expect(
      validateRuntime('ClientTransportFrame', {
        kind: 'catalog-changed',
        header,
        status: { ...status, catalogRevision: -0 },
      }).ok,
    ).toBe(false)
  })

  it('enforces the implicit welcome page and strict usable header fields', () => {
    const welcome = sample(definitions.ClientWelcome as Record<string, unknown>) as unknown as ClientWelcome
    welcome.modules = []
    welcome.domainSchemas = []
    const accepted = { welcome, catalogPage: { nextCursor: null, complete: true } }
    expect(validateClientBootstrap(accepted).ok).toBe(true)
    expect(validateClientBootstrap({ ...accepted, welcome: { ...welcome, clientInstanceId: '' } }).ok).toBe(
      false,
    )
    expect(validateClientBootstrap({ ...accepted, welcome: { ...welcome, catalogRevision: -0 } }).ok).toBe(
      false,
    )
    const refs = Array.from({ length: 101 }, (_, i) => ({
      typeId: `demo/schema${i}@1`,
      revision: 1,
      digest: 'a'.repeat(64),
    }))
    expect(validateClientBootstrap({ ...accepted, welcome: { ...welcome, domainSchemas: refs } }).ok).toBe(
      false,
    )
    expect(
      validateClientBootstrap({ ...accepted, catalogPage: { nextCursor: null, complete: false } }).ok,
    ).toBe(false)
  })

  it('classifies only fixed cancellation and revocation commands into the control channel', () => {
    for (const name of [
      'conversation.cancel',
      'jobs.cancel',
      'jobs.cancelDefinition',
      'permission.revokeGrant',
    ] as const) {
      const entry = RuntimeClientOperations[name]
      const result = clientCommandQuotaClass({
        header,
        call: { operation: name, input: sample(definitions[entry.input] as Record<string, unknown>) },
      })
      expect(result).toEqual({ ok: true, value: 'control' })
    }
    const input = {
      sessionId: 'session',
      requestId: 'request',
      expectedRevision: null,
      command: { kind: 'cancel', runId: 'run', reason: 'stop' },
    }
    expect(clientCommandQuotaClass({ header, call: { operation: 'control.submit', input } })).toEqual({
      ok: true,
      value: 'control',
    })
    expect(
      clientCommandQuotaClass({
        header,
        call: { operation: 'control.submit', input: { ...input, command: { kind: 'prompt', content: [] } } },
      }),
    ).toEqual({ ok: true, value: 'work' })
    expect(
      clientCommandQuotaClass({
        header,
        call: { operation: 'control.submit', input: { ...input, command: { kind: 'admin' } } },
      }).ok,
    ).toBe(false)
    expect(RuntimeClientTransportPolicy.controlMaxConcurrentPerWorkspace).toBe(32)
    expect(RuntimeClientTransportPolicy.controlMaxRequestsPerPrincipalPerMinute).toBe(120)
  })

  it('decodes schema-locked ephemeral credentials and proofs while rejecting forged reference bytes', () => {
    const credential = { kind: 'bearer', token: 'synthetic-test-token' }
    const evidence = {
      bindingId: 'binding',
      ingressId: 'ingress',
      requestNonce: 'nonce',
      receivedAt: '2026-10-01T00:00:00.000Z',
      transport: 'websocket',
      method: 'GET',
      path: '/api/runtime/client/stream',
      origin: null,
      authority: 'localhost',
      peerLoopback: true,
      tls: false,
      channelBinding: 'a'.repeat(64),
      proof: { kind: 'in-process', issuerBindingId: 'binding' },
    }
    const inline = (
      name: 'TransportCredentialEnvelope' | 'TransportAuthenticationEvidence',
      value: JsonValue,
    ) => ({
      kind: 'inline',
      schema: RuntimeSchemaRefs[name],
      value,
      bytes: new TextEncoder().encode(jcs(value)).length,
      digest: canonicalJsonDigest(value),
    })
    const request = {
      credentialEnvelope: inline('TransportCredentialEnvelope', credential),
      transportEvidence: inline('TransportAuthenticationEvidence', evidence),
    }
    expect(validateIdentityTransportRequest(request).ok).toBe(true)
    expect(
      validateIdentityTransportRequest({
        ...request,
        credentialEnvelope: { ...request.credentialEnvelope, bytes: 0 },
      }).ok,
    ).toBe(false)
    expect(
      validateIdentityTransportRequest({
        ...request,
        transportEvidence: inline('TransportAuthenticationEvidence', { ...evidence, transport: 'ws' }),
      }).ok,
    ).toBe(false)
    expect(
      validateIdentityTransportRequest({
        ...request,
        credentialEnvelope: inline('TransportCredentialEnvelope', { ...credential, actor: 'self-reported' }),
      }).ok,
    ).toBe(false)
  })

  it('checks every schema-declared owner error in real HTTP and WS replies while preserving opaque data', () => {
    const reserved = {
      code: 'denied',
      detailCode: 'revoked',
      message: 'revoked',
      diagnosticId: 'diagnostic',
      retryAdvice: { kind: 'never' },
    }
    const malformed = { ...reserved, code: 'conflict' }
    for (const operation of ['jobs.commandStatus', 'interaction.responseStatus', 'control.status'] as const) {
      const entry = RuntimeClientOperations[operation]
      const request = {
        header,
        call: { operation, input: sample(definitions[entry.input] as Record<string, unknown>) },
      }
      const body = sample(definitions[entry.output] as Record<string, unknown>) as Record<string, unknown>
      if (entry.output === 'CommandHandle') body.status = 'failed'
      const replyFor = (error: unknown) => ({ header, reply: { operation, value: { ...body, error } } })
      // Both variants retain valid structural shapes; only reserved semantic classification differs.
      const good = replyFor(reserved)
      expect(validateRuntime('ClientQueryReply', good).ok).toBe(true)
      expect(validateClientReply(request as never, good).ok).toBe(true)
      const bad = replyFor(malformed)
      expect(validateRuntime('ClientQueryReply', bad).ok).toBe(true)
      expect(validateClientReply(request as never, bad).ok).toBe(false)
      expect(validateClientTransportResult(request as never, { ok: true, value: bad }).ok).toBe(false)
      expect(validateClientTransportFrame(header, { kind: 'reply', result: bad }).ok).toBe(false)
      expect(validateClientTransportReplyFrame(request as never, { kind: 'reply', result: bad }).ok).toBe(
        false,
      )
    }
    const entry = RuntimeClientOperations['jobs.commandStatus']
    const request = {
      header,
      call: {
        operation: 'jobs.commandStatus' as const,
        input: sample(definitions[entry.input] as Record<string, unknown>),
      },
    }
    const body = sample(definitions.CommandHandle as Record<string, unknown>) as Record<string, unknown>
    const opaque = { error: malformed, nested: { code: 'conflict', detailCode: 'revoked' } }
    const result = {
      kind: 'inline',
      schema: { typeId: 'example/opaque@1', revision: 1, digest: 'a'.repeat(64) },
      value: opaque,
      bytes: new TextEncoder().encode(jcs(opaque)).length,
      digest: canonicalJsonDigest(opaque),
    }
    const reply = {
      header,
      reply: {
        operation: 'jobs.commandStatus',
        value: { ...body, status: 'succeeded', completion: 'domain-commit', result, error: null },
      },
    }
    expect(validateRuntime('ClientQueryReply', reply).ok).toBe(true)
    expect(validateClientReply(request as never, reply).ok).toBe(true)
    expect(validateClientTransportResult(request as never, { ok: true, value: reply }).ok).toBe(true)
    expect(validateClientTransportFrame(header, { kind: 'reply', result: reply }).ok).toBe(true)
  })

  it('provides browser-readable canonical metadata and real terminal interval summaries', () => {
    const metadata = { offset: 1, totalBytes: 3, bytes: 2, digest: 'a'.repeat(64) }
    const encoded = encodeClientBinaryMetadata('range', metadata)
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) throw new Error('invalid fixture')
    expect(decodeClientBinaryMetadata('range', encoded.value)).toEqual({ ok: true, value: metadata })
    expect(decodeClientBinaryMetadata('range', `${encoded.value}=`).ok).toBe(false)
    expect(decodeClientBinaryMetadata('range', 'x'.repeat(12000)).ok).toBe(false)
    expect(decodeClientBinaryMetadata('range', btoa(JSON.stringify(metadata))).ok).toBe(false)
    const request = { header, streamId: 'stream' }
    const status = {
      streamId: 'stream',
      state: 'succeeded',
      bytes: 2,
      summary: { bytes: 2, digest: 'a'.repeat(64) },
      error: null,
    }
    expect(validateClientStreamStatus(request, status).ok).toBe(true)
    expect(validateClientStreamStatus(request, { ...status, bytes: 3 }).ok).toBe(false)
    expect(validateClientStreamStatus(request, { ...status, streamId: 'another' }).ok).toBe(false)
    expect(
      validateClientStreamStatus(request, {
        streamId: 'stream',
        state: 'unknown',
        bytes: null,
        summary: null,
        error: null,
      }).ok,
    ).toBe(true)

    const call = { header, call: { operation: 'transport.streamStatus' as const, input: request } }
    const revoked = {
      code: 'denied',
      detailCode: 'revoked',
      message: 'revoked',
      diagnosticId: 'diagnostic',
      retryAdvice: { kind: 'never' },
    }
    for (const state of ['failed', 'cancelled']) {
      const terminal = { streamId: 'stream', state, bytes: 0, summary: null, error: revoked }
      const reply = { header, reply: { operation: 'transport.streamStatus', value: terminal } }
      expect(validateClientStreamStatus(request, terminal).ok).toBe(true)
      expect(validateClientTransportResult(call, { ok: true, value: reply }).ok).toBe(true)
      expect(validateClientTransportReplyFrame(call, { kind: 'reply', result: reply }).ok).toBe(true)
      const bad = { ...terminal, error: { ...revoked, code: 'conflict' } }
      const badReply = { ...reply, reply: { ...reply.reply, value: bad } }
      expect(validateClientStreamStatus(request, bad).ok).toBe(false)
      expect(validateClientTransportResult(call, { ok: true, value: badReply }).ok).toBe(false)
      expect(validateClientTransportReplyFrame(call, { kind: 'reply', result: badReply }).ok).toBe(false)
      expect(
        validateClientStreamStatus(request, {
          ...terminal,
          error: { ...revoked, detailCode: 'vendor_future_detail' },
        }).ok,
      ).toBe(true)
    }
  })

  it('rejects management header drift through HTTP and websocket query wrappers', () => {
    const good = {
      header,
      call: { operation: 'transport.streamStatus' as const, input: { header, streamId: 'stream' } },
    }
    expect(validateClientQueryRequest(good).ok).toBe(true)
    expect(validateClientTransportRequestFrame({ kind: 'query', request: good }).ok).toBe(true)
    const drift = {
      ...good,
      call: {
        ...good.call,
        input: { ...good.call.input, header: { ...header, clientInstanceId: 'forged' } },
      },
    }
    expect(validateClientQueryRequest(drift).ok).toBe(false)
    expect(validateClientTransportRequestFrame({ kind: 'query', request: drift }).ok).toBe(false)
    expect(validateClientTransportRequestFrame({ kind: 'command', request: good }).ok).toBe(false)
    const status = { streamId: 'other-stream', state: 'unknown', bytes: null, summary: null, error: null }
    expect(
      validateClientReply(good, { header, reply: { operation: 'transport.streamStatus', value: status } }).ok,
    ).toBe(false)
  })

  it('checks the unique error map in actual HTTP and websocket failure consumers', () => {
    const request = { header, call: { operation: 'interaction.read' as const, input: 'interaction' } }
    const error = {
      code: 'denied',
      detailCode: 'revoked',
      message: 'revoked',
      retryAdvice: { kind: 'never' },
      safeDetail: null,
      diagnosticId: 'diagnostic',
    }
    expect(validateClientTransportResult(request, { ok: false, error }).ok).toBe(true)
    expect(validateClientTransportFrame(header, { kind: 'error', header, error }).ok).toBe(true)
    const misclassified = { ...error, code: 'conflict' }
    expect(validateClientTransportResult(request, { ok: false, error: misclassified }).ok).toBe(false)
    expect(validateClientTransportFrame(header, { kind: 'error', header, error: misclassified }).ok).toBe(
      false,
    )
    expect(
      validateClientTransportResult(request, {
        ok: false,
        error: { ...error, detailCode: 'vendor-new-detail' },
      }).ok,
    ).toBe(true)
    expect(
      validateClientTransportFrame(header, {
        kind: 'error',
        header: { ...header, negotiatedSession: 'old' },
        error,
      }).ok,
    ).toBe(false)
  })

  it('matches websocket reply operation with the registered original call', () => {
    const request = { header, call: { operation: 'interaction.read' as const, input: 'interaction' } }
    const value = sample(definitions.InteractionRecord as Record<string, unknown>)
    const result = { header, reply: { operation: 'interaction.read', value } }
    expect(validateClientTransportReplyFrame(request, { kind: 'reply', result }).ok).toBe(true)
    expect(
      validateClientTransportReplyFrame(request, {
        kind: 'reply',
        result: { ...result, reply: { operation: 'approval.read', value } },
      }).ok,
    ).toBe(false)
  })
})
