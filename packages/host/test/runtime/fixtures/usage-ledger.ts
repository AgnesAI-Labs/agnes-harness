import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ledgerPlugin } from '@agnes/base'
import { fakeSeamInit } from '@agnes/base/testkit'
import { Context } from '@agnes/cordis'
import {
  createDefaultUsageFactory,
  type DefaultUsageAuthority,
  type LedgerRow,
  type LedgerSeam,
} from '@agnes/core'
import {
  type CallContext,
  defineGeneratedAuthorSchema,
  type Outcome,
  type ScopedDependencies,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs } from '@agnes/protocol/runtime'
import { createSqliteStorage } from '../../../src/adapters/storage-sqlite.js'
import { assembleRuntimeUsageLedger, type UsageLedgerOwners } from '../../../src/assemble/usage-ledger.js'
import { inline } from '../../../src/runtime/trace/provider-support.js'

type Store = DefaultUsageAuthority['store']
type Tx = Parameters<Parameters<Store['transaction']>[1]>[0]
type Fact = NonNullable<ReturnType<Tx['fact']>>
export const scope = {
  kind: 'session' as const,
  installationId: 'install',
  runtimeId: 'runtime',
  workspaceId: 'workspace',
  sessionId: 'session',
}
export const attempt = (id = '1'): W.AttemptRef => ({
  run: {
    runId: 'run',
    session: {
      sessionId: 'session',
      authority: { authorityId: 'state', tenantId: 'tenant', authorityEpoch: 1 },
    },
  },
  actionId: `action-${id}`,
  attemptId: `attempt-${id}`,
})
export const measurement = (kind: W.UsageMeasurement['kind'] = 'reported'): W.UsageMeasurement => ({
  kind,
  quantities:
    kind === 'unknown'
      ? []
      : [
          { unit: 'input-token', value: '4' },
          { unit: 'output-token', value: '2' },
        ],
  actualModel: kind === 'unknown' ? null : 'model',
  source: kind === 'estimated' ? 'estimator' : 'adapter-counter',
  sourceReceipt: null,
  replacesFactIds: [],
  ...(kind === 'unknown'
    ? {}
    : {
        credits: 0,
        creditSource: 'gateway' as const,
        billing: { usdMicros: 0, source: 'gateway' as const, subscription: false },
      }),
})
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value })
export const denied = (detailCode: string): Outcome<never> => ({
  ok: false,
  error: {
    code: 'denied',
    detailCode,
    message: 'Fixture owner refused',
    diagnosticId: 'fixture',
    retryAdvice: { kind: 'never' },
  },
})
const config = defineGeneratedAuthorSchema<Record<string, never>>({
  ownerPackageId: 'fixture',
  name: 'Config',
  typeId: 'fixture/config@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/Config',
    $defs: { Config: { type: 'object', additionalProperties: false, properties: {}, required: [] } },
  },
})

const measurementCodec = defineGeneratedAuthorSchema<W.UsageMeasurement>({
  ownerPackageId: 'fixture',
  name: 'Measurement',
  typeId: 'fixture/measurement@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/Measurement',
    $defs: {
      Measurement: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'quantities', 'actualModel', 'source', 'sourceReceipt', 'replacesFactIds'],
        properties: {
          kind: { enum: ['reported', 'estimated', 'corrected', 'unknown'] },
          quantities: {
            type: 'array',
            items: {
              type: 'object',
              required: ['unit', 'value'],
              additionalProperties: false,
              properties: { unit: { type: 'string' }, value: { type: 'string' } },
            },
          },
          actualModel: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          source: { enum: ['adapter-counter', 'estimator'] },
          sourceReceipt: { type: 'null' },
          replacesFactIds: { type: 'array', items: { type: 'string' } },
          credits: { type: 'number' },
          creditSource: { enum: ['gateway', 'estimated'] },
          billing: {
            type: 'object',
            additionalProperties: false,
            required: ['usdMicros', 'source', 'subscription'],
            properties: {
              usdMicros: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
              source: { enum: ['gateway', 'estimated'] },
              subscription: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
})
/** Synthetic committed-source owner. This fixture does not install production State or Kernel mapping. */
export async function ledgerFixture(dir: string) {
  const db = new DatabaseSync(join(dir, 'usage.sqlite'))
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS kv(kind TEXT,key TEXT,value TEXT,PRIMARY KEY(kind,key)); CREATE TABLE IF NOT EXISTS revision(id INTEGER PRIMARY KEY AUTOINCREMENT)',
  )
  const get = <T>(kind: string, key: string): T | undefined => {
    const r = db.prepare('SELECT value FROM kv WHERE kind=? AND key=?').get(kind, key)
    return r ? (JSON.parse(String(r.value)) as T) : undefined
  }
  const put = (kind: string, key: string, value: unknown) => {
    db.prepare('INSERT INTO kv VALUES(?,?,?) ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value').run(
      kind,
      key,
      jcs(value),
    )
  }
  const controller = new AbortController()
  const context: CallContext = {
    principalRef: 'actor',
    scope,
    bindingId: 'usage',
    invocationId: 'invoke',
    deadline: '2099-01-01T00:00:00.000Z',
    traceRef: 'trace',
    authorizationRef: 'auth',
    signal: controller.signal,
  }
  const binding: W.BindingRef = {
    bindingId: 'usage',
    contract: 'agh.usage',
    logicalName: 'default',
    providerId: 'usage-provider',
  }
  const sourceBinding: W.BindingRef = {
    ...binding,
    bindingId: 'model',
    contract: 'agh.model',
    providerId: 'model-provider',
  }
  let revoked = false,
    writeFails = false,
    loseLedgerReply = false,
    loseUsageReply = false,
    badQuery = false
  const check = (ctx: CallContext) => {
    if (revoked || ctx.signal.aborted || ctx.authorizationRef !== 'auth') throw new Error('source revoked')
  }
  const tx: Tx = {
    verify(input, ctx) {
      check(ctx)
      const original = get<W.UsageRecordRequest>('committed', canonicalJsonDigest(input.attemptRef))
      if (!original || jcs(original) !== jcs(input)) throw new Error('source absent')
      return {
        authorityId: 'usage-authority',
        actionId: input.attemptRef.actionId,
        attemptId: input.attemptRef.attemptId,
        externalRequest: {
          system: 'model-adapter',
          requestId: input.attemptRef.attemptId,
          requestDigest: canonicalJsonDigest(input.attemptRef),
        },
        scope,
        source: sourceBinding,
        observedAt: '2026-10-05T00:00:00.000Z',
        measurement: input.measurement,
        measurementRef: inline(measurementCodec.ref, input.measurement),
        certainty:
          input.measurement.kind === 'unknown'
            ? 'unknown'
            : input.measurement.kind === 'estimated'
              ? 'estimated'
              : 'measured',
        sourceDigest: canonicalJsonDigest(original),
        purpose: 'primary-model',
        parentActionId: 'parent',
      }
    },
    origin: (authority, key) => get('origin', jcs([authority, key])),
    fact: (key) => get('fact', key),
    putFact(record) {
      put('fact', record.ref.usageId, record)
    },
    putOrigin(record) {
      put('origin', jcs([record.authorityId, record.originKey]), record)
    },
    replay: (key) => get('replay', key),
    remember: (key, fingerprint, result) => put('replay', key, { fingerprint, result }),
    assertCurrent: check,
    nextRevision: () => Number(db.prepare('INSERT INTO revision DEFAULT VALUES').run().lastInsertRowid),
  }
  const authority: DefaultUsageAuthority = {
    store: {
      async transaction(ctx, body) {
        db.exec('BEGIN IMMEDIATE')
        try {
          const value = body(tx)
          check(ctx)
          db.exec('COMMIT')
          return value
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
      },
    },
    now: () => '2026-10-05T00:00:00.000Z',
    open: async () => ok(undefined),
    readConfig: async (ref) => (ref.kind === 'inline' ? ok(ref.value) : denied('config')),
    read: async (ref) => (ref.kind === 'inline' ? ok(ref.value) : denied('ref')),
    checkCurrent: async (ctx) => {
      check(ctx)
      return ok(undefined)
    },
    operationOwner: async () => ok({ kind: 'reconciliation', id: 'usage-reconcile' }),
    publish: async (schema, value) => ok(inline(schema, value)),
    query: async (_input, ctx) => {
      check(ctx)
      const facts = db
        .prepare("SELECT value FROM kv WHERE kind='fact' ORDER BY key")
        .all()
        .map((r) => (JSON.parse(String(r.value)) as Fact).fact)
      const snapshot = canonicalJsonDigest(facts)
      return ok({
        value: {
          items: badQuery ? facts.map((f) => ({ ...f, attemptId: 'wrong' })) : facts,
          snapshot,
          nextCursor: null,
          complete: true,
        },
        snapshot,
      })
    },
    health: async () => ok({ status: 'ready', diagnosticIds: [] }),
    drain: async () =>
      ok({ state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] }),
    close: async () => {},
  }
  const descriptor: W.ProviderDescriptor = {
    providerId: binding.providerId,
    contract: binding.contract,
    logicalName: binding.logicalName,
    major: 1,
    packageVersion: '1.0.0',
    packageDigest: 'a'.repeat(64),
    features: [],
    scope: 'session',
    configSchema: config.ref,
    requires: [],
    capabilities: [],
    recovery: 'R1',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: ['record', 'query'].map((name) => {
      const method = name as 'record' | 'query'
      const refs = RuntimeMethodSchemaRefs['agh.usage'][method]
      return {
        method,
        kind: method === 'record' ? ('control' as const) : ('query' as const),
        inputSchema: refs.input,
        outputSchema: refs.output,
        requiredCapabilities: [],
        retrySafety: method === 'record' ? ('idempotent' as const) : ('read-only' as const),
      }
    }),
  }
  const dependencies: ScopedDependencies = {
    get: () => denied('no-dependency'),
    openScope: async () => ok(dependencies),
    close: async () => {},
  }
  const cfg = config.encode({})
  if (!cfg.ok) throw new Error('config')
  const provider = await createDefaultUsageFactory(descriptor, authority, config).create(
    cfg.value,
    dependencies,
    { instanceId: 'usage-instance', scope, bindingId: binding.bindingId, signal: controller.signal },
  )
  const storage = createSqliteStorage({ file: join(dir, 'core.sqlite') })
  const tables = storage.tables('budget')
  const init = fakeSeamInit({ dataDir: dir })
  const cordis = new Context()
  cordis.provide('host:seam-init', () => ({ ...init, adapters: { ...init.adapters, storage: tables } }))
  const disposeLedger = await ledgerPlugin.apply(cordis, { name: 'fixture' })
  const ledger = cordis.get('seam:ledger') as LedgerSeam
  const owners: UsageLedgerOwners = {
    installer: {
      async connect(_attempt, signal) {
        return ok({
          binding,
          authorityId: 'usage-authority',
          provider: {
            ...provider,
            async control(req, ctx) {
              if (!provider.control) throw new Error('control')
              const result = await provider.control(req, ctx)
              if (loseUsageReply) {
                loseUsageReply = false
                throw new Error('lost usage reply')
              }
              return result
            },
          },
          context: { ...context, signal: AbortSignal.any([signal, context.signal]) },
          resolve: async (ref) => (ref.kind === 'inline' ? ok(ref.value) : denied('blob')),
          close() {},
        })
      },
    },
    state: {
      async verify(ref, ctx) {
        check(ctx)
        const request = get<W.UsageRecordRequest>('committed', canonicalJsonDigest(ref))
        return request
          ? ok({
              request,
              reservationRef: get<W.DomainObjectRef>('reservation', canonicalJsonDigest(ref)) ?? null,
            })
          : denied('usage_state_source_absent')
      },
    },
    session: {
      async claim(request, ctx) {
        check(ctx)
        const key = canonicalJsonDigest(request.attemptRef)
        const id = get<string>('mapping', key) ?? `effect-${request.attemptRef.attemptId}`
        put('mapping', key, id)
        put('exclusive', request.attemptRef.run.runId, true)
        const m = request.measurement
        const row: LedgerRow = {
          sessionKey: 'original-session',
          lane: 'main',
          turn: 1,
          step: Number(request.attemptRef.attemptId.split('-').at(-1)),
          purpose: 'inference',
          effectId: id,
          model: m.actualModel ?? 'unknown',
          tokens:
            m.kind === 'unknown'
              ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
              : { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 },
          creditSource: m.creditSource ?? 'estimated',
          ...(m.credits === undefined ? {} : { credits: m.credits }),
          ...(m.billing === undefined ? {} : { billing: m.billing }),
        }
        return ok({
          mode: 'runtime-exclusive' as const,
          row,
          ledger: {
            async record(value) {
              if (writeFails) throw new Error('disk full')
              await ledger.record(value)
              if (loseLedgerReply) {
                loseLedgerReply = false
                throw new Error('lost ledger reply')
              }
            },
          },
        })
      },
    },
  }
  const consumer = assembleRuntimeUsageLedger(join(dir, 'delivery.sqlite'), owners)
  return {
    owners,
    consumer,
    controller,
    context,
    commit(ref = attempt(), value = measurement()) {
      put('committed', canonicalJsonDigest(ref), {
        attemptRef: ref,
        externalReceiptRef: null,
        measurement: value,
      })
    },
    reserve(ref: W.AttemptRef, reservation: W.DomainObjectRef) {
      put('reservation', canonicalJsonDigest(ref), reservation)
    },
    rows: () =>
      tables.table('usage_ledger').all<{
        effect_id: string
        credits: number | null
        credit_source: string
      }>('SELECT * FROM usage_ledger ORDER BY effect_id'),
    facts: () => Number(db.prepare("SELECT count(*) AS n FROM kv WHERE kind='fact'").get()?.n),
    failLedger() {
      writeFails = true
    },
    loseLedgerReply() {
      loseLedgerReply = true
    },
    loseUsageReply() {
      loseUsageReply = true
    },
    badQuery() {
      badQuery = true
    },
    revoke() {
      revoked = true
    },
    async legacyWrite(runId: string, row: LedgerRow) {
      if (get('exclusive', runId)) return denied('runtime_owned')
      await ledger.record(row)
      return ok(undefined)
    },
    async close() {
      await consumer.close()
      await provider.close('shutdown')
      await disposeLedger()
      await storage.close()
      db.close()
    },
  }
}
