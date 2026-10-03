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
import { afterEach, describe, expect, it } from 'vitest'
import {
  createUsageOrigins,
  type StoredUsageFact,
  UsageOriginFault,
  type UsageOriginStore,
  type UsageOriginTransaction,
  type VerifiedUsageOrigin,
} from '../../src/runtime/usage/origins.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scope = {
  kind: 'session' as const,
  installationId: 'installation',
  runtimeId: 'runtime',
  workspaceId: 'workspace',
  sessionId: 'session',
}
const context: CallContext = {
  principalRef: 'actor',
  scope,
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
const measurement = (kind: UsageMeasurement['kind'] = 'reported'): UsageMeasurement => ({
  kind,
  quantities: kind === 'unknown' ? [] : [{ unit: 'input-token', value: '4' }],
  actualModel: kind === 'unknown' ? null : 'actual-model',
  source: kind === 'estimated' ? 'estimator' : 'adapter-counter',
  sourceReceipt: null,
  replacesFactIds: [],
})
const request = (value: UsageMeasurement): UsageRecordRequest => ({
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
function fixture(path?: string) {
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
      ctx.authorizationRef !== context.authorizationRef ||
      ctx.bindingId !== context.bindingId ||
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
      scope,
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

describe('actual persistent Usage origins', () => {
  it('deduplicates one original external request across cold restart without inventing a new revision', async () => {
    const f = fixture(),
      value = measurement()
    f.observe(value)
    const first = await f.operations.record(request(value), context)
    expect(first.revision).toBe(1)
    expect(f.count()).toBe(1)
    expect(await f.operations.record(request(value), context)).toEqual(first)
    const file = f.file
    f.close()
    const cold = fixture(file)
    expect(await cold.operations.record(request(value), context)).toEqual(first)
    expect(cold.count()).toBe(1)
    cold.close()
  })
  it('appends verified corrections and preserves old immutable facts while rejecting changed uncorrected usage', async () => {
    const f = fixture(),
      value = measurement()
    f.observe(value)
    const first = await f.operations.record(request(value), context)
    const changed = { ...value, quantities: [{ unit: 'input-token', value: '8' }] }
    f.observe(changed)
    await expect(f.operations.record(request(changed), context)).rejects.toThrow('verified correction')
    const correction = {
      ...changed,
      kind: 'corrected' as const,
      replacesFactIds: [first.factRefs[0]!.usageId],
    }
    f.observe(correction)
    const second = await f.operations.record(request(correction), context)
    expect(second.revision).toBe(2)
    expect(f.count()).toBe(2)
    expect(f.get<StoredUsageFact>('fact', first.factRefs[0]!.usageId)?.measurement).toEqual(value)
    const stale = { ...correction, quantities: [{ unit: 'input-token', value: '9' }] }
    f.observe(stale)
    await expect(f.operations.record(request(stale), context)).rejects.toThrow('current original')
    f.close()
  })
  it('keeps unknown distinct from zero or measured and does not guess a missing external request', async () => {
    const f = fixture(),
      value = measurement('unknown')
    f.observe(value, 'unknown')
    const result = await f.operations.record(request(value), context)
    const stored = f.get<StoredUsageFact>('fact', result.factRefs[0]!.usageId)!
    expect(stored.fact.certainty).toBe('unknown')
    expect(stored.measurement.quantities).toEqual([])
    expect(stored.measurement.actualModel).toBeNull()
    const guessed = { ...value, quantities: [{ unit: 'input-token', value: '0' }] }
    f.observe(guessed, 'unknown')
    await expect(f.operations.record(request(guessed), context)).rejects.toThrow('certainty')
    const noOrigin = fixture()
    noOrigin.observe(measurement())
    noOrigin.db.prepare("DELETE FROM facts WHERE kind='attempt'").run()
    await expect(noOrigin.operations.record(request(measurement()), context)).rejects.toThrow(
      'source not found',
    )
    f.close()
    noOrigin.close()
  })
  it('rolls back facts, origin index and authority revision when qualification changes just before COMMIT', async () => {
    const f = fixture(),
      value = measurement()
    f.observe(value)
    f.beforeCommit(() => f.revoke())
    await expect(f.operations.record(request(value), context)).rejects.toThrow('revoked')
    expect(f.count()).toBe(0)
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM revisions').get() as { n: number }).n).toBe(0)
    f.close()
  })
  it('does not turn an estimated or corrected label into measured evidence', async () => {
    const f = fixture(),
      value = measurement('estimated')
    f.observe(value, 'measured')
    await expect(f.operations.record(request(value), context)).rejects.toThrow('certainty')
    expect(f.count()).toBe(0)
    f.close()
  })
  it('rejects a corrupted original replacement fact before persisting a correction', async () => {
    const f = fixture(),
      value = measurement()
    f.observe(value)
    const first = await f.operations.record(request(value), context)
    const original = f.get<StoredUsageFact>('fact', first.factRefs[0]!.usageId)!
    f.put('fact', original.fact.usageId, { ...original, fact: { ...original.fact, certainty: 'unknown' } })
    const correction = { ...value, kind: 'corrected' as const, replacesFactIds: [original.fact.usageId] }
    f.observe(correction)
    await expect(f.operations.record(request(correction), context)).rejects.toThrow('membership')
    expect(f.count()).toBe(1)
    f.close()
  })
})
