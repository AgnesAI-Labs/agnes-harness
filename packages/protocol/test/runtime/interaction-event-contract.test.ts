import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RuntimeApprovalIntentPolicy, RuntimeEventsOutboxAPI } from '../../gen/ts/runtime-catalog.js'
import { jcs } from '../../src/jcs.js'
import {
  computeApprovalIntentDigest,
  validateApprovalAnswerForRequest,
  validateApprovalIntent,
  validateDomainCommandSchemas,
  validateEventsPublishSchemas,
  validateInlineApprovalAnswerReference,
  validateOutboxDeadLetter,
  validateProjectionChanges,
} from '../../src/runtime/client-interaction-contract.js'
import {
  canonicalJsonDigest,
  RuntimeSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '../../src/runtime/index.js'
import { normalizeRuntimeCatalog } from '../../tools/gen-runtime-catalog.js'
import { generateFullRuntimeArtifacts, loadRuntimeSchemaGraph } from '../../tools/gen-runtime-full.js'

const graph = loadRuntimeSchemaGraph(resolve(import.meta.dirname, '../../schema/runtime'))
const definitions = graph.document.$defs ?? {}
const require = createRequire(import.meta.url)
const Ajv2020 = require('ajv/dist/2020.js').default
const ajv = new Ajv2020({ strict: false })
require('ajv-formats')(ajv)

function sample(schema: Record<string, unknown>): unknown {
  if (typeof schema.$ref === 'string')
    return sample(definitions[schema.$ref.slice(8)] as Record<string, unknown>)
  if ('const' in schema) return schema.const
  if (Array.isArray(schema.enum)) return schema.enum[0]
  const union = schema.anyOf ?? schema.oneOf
  if (Array.isArray(union)) return sample(union.find((branch) => branch.type === 'null') ?? union[0])
  if (schema.type === 'null') return null
  if (schema.type === 'boolean') return false
  if (schema.type === 'number' || schema.type === 'integer') return schema.minimum ?? 0
  if (schema.type === 'string') {
    if (schema.format === 'date-time') return '2026-10-01T00:00:00.000Z'
    return (
      ['sample', 'demo/schema@1', 'a'.repeat(64), `sha256-${'a'.repeat(64)}`].find(
        (value) => !schema.pattern || new RegExp(String(schema.pattern)).test(value),
      ) ?? ''
    )
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
  throw new Error(`unsupported fixture ${jcs(schema)}`)
}
const fixture = (name: string) =>
  sample(definitions[name] as Record<string, unknown>) as Record<string, unknown>
const schemaRef = { typeId: 'demo/input@1', revision: 1, digest: 'a'.repeat(64) }
const error = fixture('RuntimeError')
const scope = {
  kind: 'workspace',
  installationId: 'installation',
  runtimeId: 'runtime',
  workspaceId: 'workspace',
}
const inline = (value: null | Record<string, string>, ref = schemaRef) => ({
  kind: 'inline',
  schema: ref,
  value,
  digest: canonicalJsonDigest(value),
  bytes: new TextEncoder().encode(jcs(value)).length,
})
function approval() {
  const request = {
    ...fixture('ApprovalRequest'),
    allowedResponders: ['reader-b', 'reader-a'],
    allowedGrantScopes: ['once', 'session'],
  }
  const computed = computeApprovalIntentDigest(request)
  if (!computed.ok) throw new Error(JSON.stringify(computed))
  return { ...request, intentDigest: computed.value }
}
const oracle = (name: string, value: unknown) =>
  ajv.compile({ $defs: definitions, $ref: `#/$defs/${name}` })(value)

describe('interaction, projection, command and event contracts', () => {
  it('requires the lifecycle-dependent resolution and terminal reason in both validators', () => {
    const pending = fixture('InteractionRecord')
    expect(validateRuntime('InteractionRecord', pending).ok).toBe(true)
    const withAnswer = { ...pending, resolution: fixture('InteractionResponseStatus') }
    for (const invalid of [
      withAnswer,
      { ...pending, status: 'answered' },
      { ...pending, status: 'cancelled' },
      { ...pending, version: 0 },
    ]) {
      expect(validateRuntime('InteractionRecord', invalid).ok).toBe(false)
      expect(oracle('InteractionRecord', invalid)).toBe(false)
    }
    const terminal = { ...pending, status: 'expired', terminationReason: 'deadline' }
    expect(validateRuntime('InteractionRecord', terminal).ok).toBe(true)
    expect(oracle('InteractionRecord', terminal)).toBe(true)
  })

  it('binds the exact intent fields while keeping input and display summaries distinct', () => {
    const request = approval()
    expect(validateApprovalIntent(request).ok).toBe(true)
    expect(
      computeApprovalIntentDigest({ ...request, title: 'Different display', body: 'More context' }),
    ).toEqual(computeApprovalIntentDigest(request))
    expect(
      computeApprovalIntentDigest({ ...request, allowedResponders: ['reader-a', 'reader-b', 'reader-a'] }),
    ).toEqual(computeApprovalIntentDigest(request))
    for (const field of ['actionRef', 'policyDecisionRef', 'risk', 'scope', 'expiresAt'] as const) {
      const replacement =
        field === 'scope'
          ? { ...scope, workspaceId: 'other' }
          : field === 'risk'
            ? 'budget'
            : field === 'expiresAt'
              ? '2026-10-02T00:00:00.000Z'
              : 'other'
      expect(validateApprovalIntent({ ...request, [field]: replacement }).ok).toBe(false)
    }
    expect(validateApprovalIntent({ ...request, inputDigest: 'b'.repeat(64) }).ok).toBe(false)
    expect(RuntimeApprovalIntentPolicy.riskMutableByHook).toBe(false)
    expect(Object.isFrozen(RuntimeApprovalIntentPolicy.fields)).toBe(true)
  })

  it('fixes approval answers, exact grant fields and the official DataRef identity', () => {
    const request = approval()
    const approve = { decision: 'approve', intentDigest: request.intentDigest, grantScope: 'once' }
    const deny = { decision: 'deny', intentDigest: request.intentDigest }
    expect(validateApprovalAnswerForRequest(request, approve).ok).toBe(true)
    expect(validateApprovalAnswerForRequest(request, deny).ok).toBe(true)
    expect(validateApprovalAnswerForRequest(request, { ...approve, grantScope: 'permanent' }).ok).toBe(false)
    for (const invalid of [
      { ...deny, grantScope: 'once' },
      { decision: 'approve', intentDigest: request.intentDigest },
      { ...approve, intentDigest: 'b'.repeat(64) },
    ])
      expect(validateApprovalAnswerForRequest(request, invalid).ok).toBe(false)
    const data = inline(approve, RuntimeSchemaRefs.ApprovalAnswer)
    expect(validateRuntime('ApprovalAnswerDataRef', data).ok).toBe(true)
    expect(validateInlineApprovalAnswerReference(request, data).ok).toBe(true)
    expect(
      validateInlineApprovalAnswerReference(request, {
        ...data,
        schema: { ...data.schema, digest: 'b'.repeat(64) },
      }).ok,
    ).toBe(false)
    expect(validateInlineApprovalAnswerReference(request, { ...data, digest: 'b'.repeat(64) }).ok).toBe(false)
    expect(validateInlineApprovalAnswerReference(request, { ...data, bytes: data.bytes + 1 }).ok).toBe(false)
    expect(validateRuntime('ApprovalAnswerDataRef', { ...data, schema: schemaRef }).ok).toBe(false)
    expect(validateRuntime('ApprovalAnswerDataRef', { ...data, value: { confirmed: true } }).ok).toBe(false)
    expect(validateRuntime('ApprovalRequest', { ...request, risk: 'low' }).ok).toBe(false)
    const oldDigest: Record<string, unknown> = {
      ...fixture('ApprovalRespondRequest'),
      actionDigest: request.intentDigest,
    }
    delete oldDigest.intentDigest
    expect(validateRuntime('ApprovalRespondRequest', oldDigest).ok).toBe(false)
  })

  it('uses interactionId for lifecycle requests and excludes caller evidence', () => {
    const request = { interactionId: 'interaction', expectedVersion: 1, reason: 'cancelled' }
    for (const name of ['InteractionExpireRequest', 'InteractionCancelRequest'] as const) {
      expect(validateRuntime(name, request).ok).toBe(true)
      expect(validateRuntime(name, { ...request, id: 'interaction' }).ok).toBe(false)
      expect(validateRuntime(name, { id: 'interaction', expectedVersion: 1, reason: 'cancelled' }).ok).toBe(
        false,
      )
      expect(validateRuntime(name, { ...request, actorRef: 'forged' }).ok).toBe(false)
    }
  })

  it('keeps DomainViewChange as the canonical alias and validates reset boundaries', () => {
    const snapshot = { ...fixture('ProjectionSnapshot'), cursor: 'snapshot-cursor' }
    const reset = { kind: 'reset', snapshot }
    expect(validateRuntime('DomainViewChange', reset).ok).toBe(true)
    expect(validateRuntime('ProjectionChange', reset).ok).toBe(true)
    expect(validateRuntime('DomainViewChange', { ...reset, cursor: 'second-cursor' }).ok).toBe(false)
    const batch = { changes: [reset], cursor: 'snapshot-cursor', hasMore: false }
    expect(validateProjectionChanges(batch).ok).toBe(true)
    for (const invalid of [
      { ...batch, cursor: 'other' },
      { ...batch, hasMore: true },
      { ...batch, changes: [reset, reset] },
    ])
      expect(validateProjectionChanges(invalid).ok).toBe(false)
  })

  it('requires completion and keeps not-accepted as a genuinely empty identity branch', () => {
    const accepted = { ...fixture('CommandHandle'), completion: 'domain-commit' }
    expect(validateRuntime('CommandHandle', accepted).ok).toBe(true)
    const { completion: _completion, ...missing } = accepted
    expect(validateRuntime('CommandHandle', missing).ok).toBe(false)
    const notAccepted = {
      requestId: 'request',
      status: 'not-accepted',
      commandId: null,
      revision: null,
      completion: null,
      result: null,
      error: null,
    }
    expect(validateRuntime('CommandHandle', notAccepted).ok).toBe(true)
    expect(validateRuntime('CommandHandle', { ...notAccepted, commandId: 'invented' }).ok).toBe(false)
    expect(validateRuntime('CommandHandle', { ...accepted, status: 'failed', error: null }).ok).toBe(false)
    expect(
      validateRuntime('CommandHandle', {
        ...accepted,
        status: 'succeeded',
        completion: 'runtime-accepted',
        result: null,
      }).ok,
    ).toBe(false)
    const status = {
      responseId: 'response',
      status: 'not-accepted',
      interactionId: null,
      version: null,
      result: null,
      error: null,
    }
    expect(validateRuntime('InteractionResponseStatus', status).ok).toBe(true)
    expect(validateRuntime('InteractionResponseStatus', { ...status, version: 0 }).ok).toBe(false)
    expect(RuntimeServiceCatalog['agh.supervisor'].methods.submitConversation.completion).toBe(
      'runtime-accepted',
    )
    expect(RuntimeServiceCatalog['agh.jobs'].methods.acceptCreateDefinition.completion).toBe('domain-commit')
  })

  it('requires command schema to match input, authorized view and the registered definition', () => {
    const request = {
      ...fixture('DomainCommandClientSubmitRequest'),
      input: inline(null),
      commandSchema: schemaRef,
    }
    expect(validateDomainCommandSchemas(request, schemaRef, schemaRef).ok).toBe(true)
    for (const field of ['typeId', 'revision', 'digest'] as const) {
      const other = {
        ...schemaRef,
        [field]: field === 'revision' ? 2 : field === 'digest' ? 'b'.repeat(64) : 'other/input@1',
      }
      expect(validateDomainCommandSchemas(request, other, schemaRef).ok).toBe(false)
      expect(validateDomainCommandSchemas(request, schemaRef, other).ok).toBe(false)
    }
    expect(
      validateDomainCommandSchemas(
        { ...request, input: inline(null, { ...schemaRef, revision: 2 }) },
        schemaRef,
        schemaRef,
      ).ok,
    ).toBe(false)
    expect(
      validateRuntime('DomainCommandClientSubmitRequest', { ...request, name: 'arbitrary-handler' }).ok,
    ).toBe(false)
  })

  it('limits channel attachments to stable artifact versions without file paths or grants', () => {
    const message = fixture('ChannelMessage')
    const attachment = { artifactId: 'artifact', version: 1, disposition: 'attachment' }
    expect(validateRuntime('ChannelMessage', message).ok).toBe(true)
    expect(validateRuntime('ChannelMessage', { ...message, attachments: [attachment] }).ok).toBe(true)
    for (const attachments of [
      [{ ...attachment, path: '/fixture/file' }],
      [{ ...attachment, url: 'https://example.test/file' }],
      [attachment, attachment],
      Array.from({ length: 33 }, (_, version) => ({ ...attachment, version })),
    ])
      expect(validateRuntime('ChannelMessage', { ...message, attachments }).ok).toBe(false)
  })

  it('maps the real workspace list query and checks UTF8, scope and limits', () => {
    const request = { scope, text: null, cursor: null, limit: 128 }
    expect(validateRuntime('ConversationListRequest', request).ok).toBe(true)
    expect(
      validateRuntime('ConversationListRequest', {
        ...request,
        scope: { ...scope, kind: 'session', sessionId: 'session' },
      }).ok,
    ).toBe(false)
    expect(validateRuntime('ConversationListRequest', { ...request, text: '😀'.repeat(256) }).ok).toBe(true)
    expect(validateRuntime('ConversationListRequest', { ...request, text: '😀'.repeat(257) }).ok).toBe(false)
    expect(validateRuntime('ConversationListRequest', { ...request, limit: 129 }).ok).toBe(false)
    expect(RuntimeServiceCatalog['agh.projection'].methods.listConversations.kind).toBe('query')
  })

  it('registers outbox operations only for the actual State owner and retains the whole delivery key', () => {
    expect(RuntimeEventsOutboxAPI.contracts).toEqual(['agh.state'])
    const catalog = normalizeRuntimeCatalog(graph.publicDocument, new Set(Object.keys(definitions)))
    const changed = structuredClone(graph.publicDocument)
    const alteredOutbox = changed['x-events-outbox-api'] as { contracts: string[] }
    alteredOutbox.contracts.push('agh.transport')
    expect(() => normalizeRuntimeCatalog(changed)).toThrow('outbox owner template')
    for (const [name, entry] of Object.entries(catalog)) {
      const methods = (entry as { methods: Record<string, unknown> }).methods
      expect(Object.hasOwn(methods, 'redriveOutbox')).toBe(name === 'agh.state')
    }
    expect(RuntimeServiceCatalog['agh.state'].methods.redriveOutbox).toMatchObject({
      kind: 'control',
      requiredFeature: 'outbox-administration.v1',
      sameAttemptBrokerAllowed: false,
    })
    const item = fixture('OutboxDeadLetterItem')
    const outbox = {
      ...fixture('OutboxRecord'),
      delivery: 'dead',
      lastError: error,
      sourceAuthorityId: 'authority',
      eventId: 'event',
      destination: 'destination',
    }
    item.outbox = outbox
    item.delivery = { sourceAuthorityId: 'authority', eventId: 'event', destination: 'destination' }
    const owner = item.owner as { authority: { authorityId: string } }
    owner.authority.authorityId = 'authority'
    expect(validateOutboxDeadLetter(item).ok).toBe(true)
    expect(
      validateOutboxDeadLetter({ ...item, delivery: { ...(item.delivery as object), destination: 'other' } })
        .ok,
    ).toBe(false)
    expect(validateRuntime('OutboxRecord', { ...outbox, lastError: null }).ok).toBe(false)
    expect(
      validateRuntime('OutboxRedriveRequest', { ...fixture('OutboxRedriveRequest'), eventId: 'event' }).ok,
    ).toBe(false)
  })

  it('rejects Local outbox drift from the sole owner method template', () => {
    const temporary = mkdtempSync(resolve(tmpdir(), 'runtime-owner-contract-'))
    try {
      const copied = resolve(temporary, 'schema')
      cpSync(resolve(import.meta.dirname, '../../schema'), copied, { recursive: true })
      const file = resolve(copied, 'runtime/local-api.json')
      const local = JSON.parse(readFileSync(file, 'utf8'))
      local['x-local-api'].runtime.EventsOutboxControl = local[
        'x-local-api'
      ].runtime.EventsOutboxControl.replace('Wire.OutboxRedriveRequest', 'Wire.Id')
      writeFileSync(file, JSON.stringify(local))
      expect(() => generateFullRuntimeArtifacts(resolve(copied, 'runtime'))).toThrow(
        'Local events outbox signature disagrees',
      )
      expect(Object.isFrozen(RuntimeEventsOutboxAPI.methods.redriveOutbox)).toBe(true)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })

  it('requires publish identity and schema agreement while keeping resync a failure', () => {
    const request = {
      ...fixture('EventsPublishRequest'),
      typeId: schemaRef.typeId,
      domainSchema: schemaRef,
      payload: inline(null),
      idempotencyKey: 'publish',
    }
    expect(validateEventsPublishSchemas(request).ok).toBe(true)
    expect(validateEventsPublishSchemas({ ...request, typeId: 'other/event@1' }).ok).toBe(false)
    expect(
      validateEventsPublishSchemas({ ...request, payload: inline(null, { ...schemaRef, revision: 2 }) }).ok,
    ).toBe(false)
    const { idempotencyKey: _idempotencyKey, ...missing } = request
    expect(validateRuntime('EventsPublishRequest', missing).ok).toBe(false)
    expect(
      validateRuntime('EventsSubscribeResult', { ...fixture('EventsSubscribeResult'), resyncRequired: true })
        .ok,
    ).toBe(false)
  })

  it('requires authority identity on events and a target-assigned positive inbox sequence', () => {
    const event = fixture('DomainEvent')
    expect(validateRuntime('DomainEvent', event).ok).toBe(true)
    for (const field of ['principalRef', 'correlationId', 'provenance']) {
      const missing = { ...event }
      delete missing[field]
      expect(validateRuntime('DomainEvent', missing).ok).toBe(false)
    }
    const inbox = fixture('InboxRecord')
    expect(validateRuntime('InboxRecord', inbox).ok).toBe(true)
    expect(validateRuntime('InboxRecord', { ...inbox, inboxSeq: 0 }).ok).toBe(false)
    expect(validateRuntime('InboxRecord', { ...inbox, inboxSeq: -0 }).ok).toBe(false)
    expect(validateRuntime('SignalDelivery', { ...fixture('SignalDelivery'), inboxSeq: 1 }).ok).toBe(false)
  })
})
