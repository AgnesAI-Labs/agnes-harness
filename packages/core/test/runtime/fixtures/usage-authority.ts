import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  canonicalJsonDigest,
  type UsageMeasurement,
  type UsageRecordRequest,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { afterEach } from 'vitest'
import {
  createUsageOrigins,
  type StoredUsageFact,
  UsageOriginFault,
  type UsageOriginStore,
  type UsageOriginTransaction,
  type VerifiedUsageOrigin,
} from '../../../src/runtime/usage/origins.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
export const usageScope = {
  kind: 'session' as const,
  installationId: 'installation',
  runtimeId: 'runtime',
  workspaceId: 'workspace',
  sessionId: 'session',
}
export const usageContext: CallContext = {
  principalRef: 'actor',
  scope: usageScope,
  bindingId: 'usage-binding',
  invocationId: 'invocation',
  deadline: '2099-01-01T00:00:00.000Z',
  traceRef: 'trace',
  authorizationRef: 'auth',
  signal: new AbortController().signal,
}
const schemaDocument = {
  $id: 'https://example.invalid/usage-measurement.json',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'quantities', 'actualModel', 'source', 'sourceReceipt', 'replacesFactIds'],
  properties: {
    kind: { enum: ['reported', 'estimated', 'corrected', 'unknown'] },
    quantities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['unit', 'value'],
        properties: { unit: { type: 'string' }, value: { type: 'string' } },
      },
    },
    actualModel: { type: ['string', 'null'] },
    source: { enum: ['adapter-counter', 'estimator'] },
    sourceReceipt: { type: 'null' },
    replacesFactIds: { type: 'array', items: { type: 'string' } },
  },
}
const schema = {
  typeId: 'agh.test/usage-measurement@1',
  revision: 1,
  digest: canonicalJsonDigest(schemaDocument),
}
export const usageMeasurement = (kind: UsageMeasurement['kind'] = 'reported'): UsageMeasurement => ({
  kind,
  quantities: kind === 'unknown' ? [] : [{ unit: 'input-token', value: '4' }],
  actualModel: kind === 'unknown' ? null : 'actual-model',
  source: kind === 'estimated' ? 'estimator' : 'adapter-counter',
  sourceReceipt: null,
  replacesFactIds: [],
})
export const usageRequest = (value: UsageMeasurement): UsageRecordRequest => ({
  attemptRef: {
    run: {
      runId: 'run',
      session: {
        authority: { authorityId: 'state', tenantId: 'tenant', authorityEpoch: 1 },
        sessionId: 'session',
      },
    },
    actionId: 'action',
    attemptId: 'attempt',
  },
  externalReceiptRef: null,
  measurement: value,
})
/** Original durable observation/source fixture; no production model adapter or network call is implied. */
export function usageFixture(path?: string) {
  const dir = path ? undefined : mkdtempSync(join(tmpdir(), 'usage-origins-'))
  if (dir) dirs.push(dir)
  const file = path ?? join(dir!, 'usage.sqlite'),
    db = new DatabaseSync(file)
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS facts(kind TEXT,key TEXT,value TEXT,PRIMARY KEY(kind,key)); CREATE TABLE IF NOT EXISTS revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT)',
  )
  const get = <T>(kind: string, key: string): T | undefined => {
    const row = db.prepare('SELECT value FROM facts WHERE kind=? AND key=?').get(kind, key) as
      | { value: string }
      | undefined
    return row ? (JSON.parse(row.value) as T) : undefined
  }
  const put = (kind: string, key: string, value: unknown) => {
    db.prepare(
      'INSERT INTO facts(kind,key,value) VALUES(?,?,?) ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value',
    ).run(kind, key, jcs(value))
  }
  let current = true,
    beforeCommit: (() => void) | undefined
  const check = (ctx: CallContext) => {
    if (
      !current ||
      ctx.authorizationRef !== usageContext.authorizationRef ||
      ctx.bindingId !== usageContext.bindingId ||
      ctx.signal.aborted
    )
      throw new UsageOriginFault('denied', 'actual intake authority revoked')
  }
  if (!get('attempt', 'attempt'))
    put('attempt', 'attempt', {
      actionId: 'action',
      attemptId: 'attempt',
      externalRequest: {
        system: 'model-adapter',
        requestId: 'external-request-1',
        requestDigest: canonicalJsonDigest({ body: 'actual-input' }),
      },
      scope: usageScope,
      source: {
        bindingId: 'source-binding',
        contract: 'agh.model',
        logicalName: 'model',
        providerId: 'model-provider',
      },
    })
  const tx: UsageOriginTransaction = {
    verify(input, ctx) {
      check(ctx)
      const attempt = get<
        Pick<VerifiedUsageOrigin, 'actionId' | 'attemptId' | 'externalRequest' | 'scope' | 'source'>
      >('attempt', input.attemptRef.attemptId)
      const observation = get<{ measurement: UsageMeasurement; certainty: VerifiedUsageOrigin['certainty'] }>(
        'observation',
        canonicalJsonDigest(input.measurement),
      )
      if (
        !attempt ||
        attempt.actionId !== input.attemptRef.actionId ||
        !observation ||
        !validateRuntime('UsageMeasurement', observation.measurement).ok
      )
        throw new UsageOriginFault('denied', 'actual original source not found')
      return {
        ...attempt,
        authorityId: 'usage-authority',
        observedAt: '2026-10-02T00:00:00.000Z',
        measurement: observation.measurement,
        measurementRef: {
          kind: 'inline',
          schema,
          value: observation.measurement,
          digest: canonicalJsonDigest(observation.measurement),
          bytes: Buffer.byteLength(jcs(observation.measurement)),
        },
        certainty: observation.certainty,
        sourceDigest: canonicalJsonDigest({ attempt, observation }),
        purpose: 'primary-model',
        parentActionId: 'parent',
      }
    },
    origin: (authority, key) => get('origin', jcs([authority, key])),
    fact: (id) => get('fact', id),
    putFact(record) {
      if (get('fact', record.fact.usageId))
        throw new UsageOriginFault('integrity', 'immutable fact overwrite')
      put('fact', record.fact.usageId, record)
    },
    putOrigin: (record) => put('origin', jcs([record.authorityId, record.originKey]), record),
    replay: (id) => get('replay', id),
    remember: (id, fingerprint, result) => put('replay', id, { fingerprint, result }),
    nextRevision() {
      const result = db.prepare('INSERT INTO revisions DEFAULT VALUES').run()
      return Number(result.lastInsertRowid)
    },
    assertCurrent: check,
  }
  const store: UsageOriginStore = {
    async transaction(ctx, body) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = body(tx)
        beforeCommit?.()
        check(ctx)
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  return {
    file,
    db,
    get,
    put,
    tx,
    store,
    operations: createUsageOrigins(store),
    observe(value: UsageMeasurement, certainty: VerifiedUsageOrigin['certainty'] = 'measured') {
      put('observation', canonicalJsonDigest(value), { measurement: value, certainty })
    },
    revoke() {
      current = false
    },
    beforeCommit(fn: () => void) {
      beforeCommit = fn
    },
    count: () =>
      Number((db.prepare("SELECT COUNT(*) AS n FROM facts WHERE kind='fact'").get() as { n: number }).n),
    close: () => db.close(),
  }
}
