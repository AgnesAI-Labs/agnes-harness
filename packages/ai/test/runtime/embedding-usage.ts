import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, ServiceProvider } from '@agnes/extension-api/runtime'
import { defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs } from '@agnes/protocol/runtime'
// This is the @agnes/core "." export, never a private runtime implementation.
import type { DefaultUsageAuthority } from '../../../core/src/index.js'
import { embeddingFailure, embeddingRef } from '../../src/runtime/embedding/data.js'

type Transaction = Parameters<Parameters<DefaultUsageAuthority['store']['transaction']>[1]>[0]
type Fact = NonNullable<ReturnType<Transaction['fact']>>
type Observation = {
  request: W.UsageRecordRequest
  externalRequest: W.ExternalRequestRef
  scope: W.ScopeRef
}
export const embeddingUsageBinding: W.BindingRef = {
  contract: 'agh.usage',
  logicalName: 'usage',
  bindingId: 'synthetic-usage-binding',
  providerId: 'synthetic/usage',
}
export function embeddingUsageCount(directory: string): number {
  try {
    const db = new DatabaseSync(join(directory, 'usage.sqlite'), { readOnly: true })
    try {
      return Number(
        (db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='fact'").get() as { n: number }).n,
      )
    } finally {
      db.close()
    }
  } catch {
    return 0
  }
}
/** Only the restricted network observation and durable storage are fixtures.
 * Fact creation, fingerprint conflicts and replay are the public default Usage provider. */
export async function createEmbeddingUsage(
  directory: string,
  scope: W.ScopeRef,
  current: (call: CallContext) => boolean,
) {
  const db = new DatabaseSync(join(directory, 'usage.sqlite'))
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records(kind TEXT,key TEXT,value TEXT,PRIMARY KEY(kind,key)); CREATE TABLE IF NOT EXISTS revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT)',
  )
  const get = <T>(kind: string, key: string): T | undefined => {
    const row = db.prepare('SELECT value FROM records WHERE kind=? AND key=?').get(kind, key) as
      | { value: string }
      | undefined
    return row ? (JSON.parse(row.value) as T) : undefined
  }
  const put = (kind: string, key: string, value: unknown) => {
    db.prepare(
      'INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value',
    ).run(kind, key, jcs(value))
  }
  const check = (call: CallContext) => {
    if (
      !current(call) ||
      call.signal.aborted ||
      call.bindingId !== embeddingUsageBinding.bindingId ||
      jcs(call.scope) !== jcs(scope)
    )
      throw embeddingFailure('denied', 'synthetic_source_denied').error
  }
  const originIdentity = (r: W.UsageRecordRequest) =>
    canonicalJsonDigest({ attempt: r.attemptRef, receipt: r.externalReceiptRef })
  const observationCodec = defineGeneratedAuthorSchema<W.UsageMeasurement>({
    ownerPackageId: 'synthetic-usage',
    name: 'Observation',
    typeId: 'synthetic-usage/observation@1',
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Observation',
      $defs: {
        Observation: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'quantities', 'actualModel', 'source', 'sourceReceipt', 'replacesFactIds'],
          properties: {
            kind: { const: 'reported' },
            actualModel: { const: 'synthetic-embedding' },
            source: { const: 'provider-receipt' },
            sourceReceipt: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'schema', 'value', 'digest', 'bytes'],
              properties: {
                kind: { const: 'inline' },
                digest: { type: 'string', minLength: 64, maxLength: 64 },
                bytes: { type: 'integer', minimum: 1, maximum: 65536 },
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['typeId', 'revision', 'digest'],
                  properties: {
                    typeId: { type: 'string' },
                    revision: { type: 'integer', minimum: 1, maximum: 1 },
                    digest: { type: 'string', minLength: 64, maxLength: 64 },
                  },
                },
                value: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['content', 'structured'],
                  properties: {
                    content: { type: 'array', maxItems: 0, items: { type: 'string' } },
                    structured: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['receipt', 'inputDigest'],
                      properties: {
                        receipt: { const: 'synthetic-receipt' },
                        inputDigest: { type: 'string', minLength: 64, maxLength: 64 },
                      },
                    },
                  },
                },
              },
            },
            replacesFactIds: { type: 'array', maxItems: 0, items: { type: 'string' } },
            quantities: {
              type: 'array',
              minItems: 1,
              maxItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['unit', 'value'],
                properties: { unit: { const: 'synthetic-request' }, value: { const: '1' } },
              },
            },
          },
        },
      },
    },
  })
  const tx: Transaction = {
    verify(input, call) {
      check(call)
      const source = get<Observation>('source', originIdentity(input))
      if (!source || jcs(source.request) !== jcs(input) || jcs(source.scope) !== jcs(call.scope))
        throw embeddingFailure('denied', 'synthetic_source_missing').error
      return {
        authorityId: 'synthetic-usage',
        actionId: input.attemptRef.actionId,
        attemptId: input.attemptRef.attemptId,
        source: {
          contract: 'agh.embedding',
          logicalName: 'default',
          bindingId: 'synthetic-embedding-binding',
          providerId: 'synthetic/embedding',
        },
        externalRequest: source.externalRequest,
        scope: source.scope,
        observedAt: '2026-10-04T00:00:00.000Z',
        measurement: source.request.measurement,
        measurementRef: (() => {
          const encoded = observationCodec.encode(source.request.measurement)
          if (!encoded.ok) throw Error('Source codec')
          return encoded.value
        })(),
        certainty: 'measured',
        sourceDigest: canonicalJsonDigest(source),
        purpose: 'synthetic-embedding',
        parentActionId: null,
      }
    },
    origin: (authority, key) => get('origin', jcs([authority, key])),
    fact: (id) => get('fact', id),
    putFact(record) {
      if (get('fact', record.fact.usageId)) throw Error('immutable fact overwrite')
      put('fact', record.fact.usageId, record)
    },
    putOrigin: (record) => put('origin', jcs([record.authorityId, record.originKey]), record),
    replay: (id) => get('replay', id),
    remember: (id, fingerprint, result) => put('replay', id, { fingerprint, result }),
    nextRevision: () => Number(db.prepare('INSERT INTO revisions DEFAULT VALUES').run().lastInsertRowid),
    assertCurrent: check,
  }
  const codec = defineGeneratedAuthorSchema<Record<string, never>>({
    ownerPackageId: 'synthetic-usage',
    name: 'Config',
    typeId: 'synthetic-usage/config@1',
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Config',
      $defs: { Config: { type: 'object', properties: {}, required: [], additionalProperties: false } },
    },
  })
  let closed = false
  const failure = () => ({
    ok: false as const,
    error: embeddingFailure('denied', 'synthetic_source_denied').error,
  })
  const authority: DefaultUsageAuthority = {
    store: {
      async transaction(call, body) {
        db.exec('BEGIN IMMEDIATE')
        try {
          const result = body(tx)
          check(call)
          db.exec('COMMIT')
          return result
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      },
    },
    now: () => new Date().toISOString(),
    open: async () => ({ ok: true, value: undefined }),
    readConfig: async (ref) => (ref.kind === 'inline' ? { ok: true, value: ref.value } : failure()),
    read: async (ref) => (ref.kind === 'inline' ? { ok: true, value: ref.value } : failure()),
    checkCurrent: async (call) => {
      try {
        check(call)
        return { ok: true, value: undefined }
      } catch {
        return failure()
      }
    },
    operationOwner: async (method, input, call) => {
      check(call)
      return {
        ok: true,
        value: { kind: 'reconciliation', id: canonicalJsonDigest({ method, input, scope: call.scope }) },
      }
    },
    publish: async (schema, value) => ({ ok: true, value: embeddingRef(schema, value) }),
    query: async (input, call) => {
      check(call)
      if (input.cursor !== null || jcs(input.scopeRef) !== jcs(call.scope)) return failure()
      const facts = rows<Fact>('fact')
      if (facts.length > input.limit) return failure()
      const snapshot = canonicalJsonDigest(facts)
      return {
        ok: true,
        value: {
          value: { items: facts.map((r) => r.fact), snapshot, nextCursor: null, complete: true },
          snapshot,
        },
      }
    },
    health: async () => ({ ok: true, value: { status: closed ? 'failed' : 'ready', diagnosticIds: [] } }),
    drain: async () => ({
      ok: true,
      value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
    }),
    close: async () => {
      if (!closed) {
        closed = true
        db.close()
      }
    },
  }
  function rows<T>(kind: string): T[] {
    return (
      db.prepare('SELECT value FROM records WHERE kind=? ORDER BY key').all(kind) as { value: string }[]
    ).map((r) => JSON.parse(r.value) as T)
  }
  // Resolve the declared public root entry without adding a product dependency on Core.
  const entry = new URL('../../../core/src/index.ts', import.meta.url).href
  const core = (await import(entry)) as {
    createDefaultUsageFactory: typeof import('../../../core/src/index.js').createDefaultUsageFactory
  }
  const factory = core.createDefaultUsageFactory(
    {
      providerId: embeddingUsageBinding.providerId,
      contract: 'agh.usage',
      logicalName: 'usage',
      major: 1,
      packageVersion: '0.0.0',
      packageDigest: canonicalJsonDigest(
        readFileSync(new URL('../../../core/src/runtime/providers/usage.ts', import.meta.url), 'utf8'),
      ),
      features: [],
      scope: 'workspace',
      configSchema: codec.ref,
      requires: [],
      capabilities: [],
      recovery: 'R1',
      isolation: ['trusted-in-process'],
      stateCodecs: [],
      activationMode: 'eager',
      operations: (['record', 'query'] as const).map((method) => ({
        method,
        kind: method === 'record' ? 'control' : 'query',
        inputSchema: RuntimeMethodSchemaRefs['agh.usage'][method].input,
        outputSchema: RuntimeMethodSchemaRefs['agh.usage'][method].output,
        requiredCapabilities: [],
        retrySafety: method === 'record' ? 'idempotent' : 'read-only',
      })),
    },
    authority,
    codec,
  )
  const config = codec.encode({})
  if (!config.ok) throw Error('Usage config')
  const provider = await factory.create(
    config.value,
    {
      get: failure,
      openScope: async () => failure(),
      close: async () => {},
    },
    {
      instanceId: 'synthetic-usage-instance',
      bindingId: embeddingUsageBinding.bindingId,
      scope,
      signal: new AbortController().signal,
    },
  )
  if (!provider.control) throw Error('Usage record missing')
  return {
    provider: provider as ServiceProvider & { control: NonNullable<ServiceProvider['control']> },
    observe(source: Observation) {
      const encoded = observationCodec.encode(source.request.measurement)
      if (!encoded.ok) throw Error('Restricted observation schema')
      const identity = originIdentity(source.request),
        prior = get<Observation>('source', identity)
      if (prior && jcs(prior) !== jcs(source)) throw Error('Immutable source conflict')
      if (!prior) put('source', identity, source)
    },
    records() {
      return rows<Fact>('fact').map((fact) => {
        const source = rows<Observation>('source').find(
          (s) =>
            s.request.attemptRef.actionId === fact.fact.actionId &&
            s.request.attemptRef.attemptId === fact.fact.attemptId,
        )
        const replay = rows<{ result: W.UsageRecordResult }>('replay').find((r) =>
          r.result.factRefs.some((ref) => ref.usageId === fact.fact.usageId),
        )
        if (!source || !replay) throw Error('Usage source or replay absent')
        return { request: source.request, result: replay.result, fact: fact.fact }
      })
    },
  }
}
