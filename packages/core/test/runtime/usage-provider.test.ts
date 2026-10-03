import {
  type CallContext,
  defineGeneratedAuthorSchema,
  type EmptyAuthorConfig,
  type Outcome,
  type ScopedDependencies,
} from '@agnes/extension-api/runtime'
import { contracts } from '@agnes/extension-api/testkit'
import { jcs } from '@agnes/protocol'
import {
  canonicalJsonDigest,
  type DataRef,
  type ProviderDescriptor,
  RuntimeMethodSchemaRefs,
  type RuntimeWireTypes,
  type SchemaRef,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'

const { runUsageContractScenario } = contracts
type UsageContractFixture = contracts.UsageContractFixture

import { createDefaultUsageFactory, type DefaultUsageAuthority } from '@agnes/core'
import type { StoredUsageFact } from '../../src/runtime/usage/origins.js'
import {
  usageContext,
  usageFixture,
  usageMeasurement,
  usageRequest,
  usageScope,
} from './fixtures/usage-authority.js'

const codec = defineGeneratedAuthorSchema<EmptyAuthorConfig>({
  ownerPackageId: 'usage-provider-test',
  name: 'UsageConfig',
  typeId: 'usage-provider-test/config@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/UsageConfig',
    $defs: { UsageConfig: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  },
})
const failure = (detailCode: string): Outcome<never> => ({
  ok: false,
  error: {
    code: 'denied',
    detailCode,
    message: 'Usage owner evidence is unavailable',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'usage-fixture',
  },
})
function inline<K extends keyof RuntimeWireTypes>(
  schema: SchemaRef,
  name: K,
  value: RuntimeWireTypes[K],
): DataRef {
  const parsed = validateRuntime(name, value),
    json = validateRuntime('JsonValue', value)
  if (!parsed.ok || !json.ok) throw new TypeError('fixture input')
  return {
    kind: 'inline',
    schema,
    value: json.value,
    digest: canonicalJsonDigest(json.value),
    bytes: Buffer.byteLength(jcs(json.value)),
  }
}
function fixture(path?: string) {
  const owner = usageFixture(path),
    refs = RuntimeMethodSchemaRefs['agh.usage']
  const descriptor: ProviderDescriptor = {
    providerId: 'usage-provider',
    contract: 'agh.usage',
    major: 1,
    logicalName: 'usage',
    packageVersion: '1.0.0',
    packageDigest: 'a'.repeat(64),
    features: [],
    scope: 'session',
    configSchema: codec.ref,
    requires: [],
    capabilities: [],
    recovery: 'R1',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: ['record', 'query'].map((name) => {
      const method = name as 'record' | 'query'
      return {
        method,
        kind: method === 'record' ? ('control' as const) : ('query' as const),
        inputSchema: refs[method].input,
        outputSchema: refs[method].output,
        requiredCapabilities: [],
        retrySafety: method === 'record' ? ('idempotent' as const) : ('read-only' as const),
      }
    }),
  }
  let closed = false,
    complete = true,
    afterPublish: (() => void) | undefined
  const authority: DefaultUsageAuthority = {
    store: owner.store,
    now: () => '2026-10-02T00:00:00.000Z',
    async open() {
      return { ok: true, value: undefined }
    },
    async readConfig(config) {
      return config.kind === 'inline' ? { ok: true, value: config.value } : failure('config')
    },
    async read(ref) {
      return ref.kind === 'inline' ? { ok: true, value: ref.value } : failure('data_ref')
    },
    async checkCurrent(ctx) {
      try {
        owner.tx.assertCurrent(ctx)
        return { ok: true, value: undefined }
      } catch {
        return failure('intake_revoked')
      }
    },
    async operationOwner(method, input, ctx) {
      owner.tx.assertCurrent(ctx)
      const key = canonicalJsonDigest({ method, input, scope: ctx.scope, binding: ctx.bindingId })
      const prior = owner.get<{ kind: 'reconciliation'; id: string }>('operation-owner', key)
      if (prior) return { ok: true, value: prior }
      const value = { kind: 'reconciliation' as const, id: `usage-operation-${key}` }
      owner.put('operation-owner', key, value)
      return { ok: true, value }
    },
    async publish(schema, value) {
      const ref: DataRef = {
        kind: 'inline',
        schema,
        value,
        digest: canonicalJsonDigest(value),
        bytes: Buffer.byteLength(jcs(value)),
      }
      afterPublish?.()
      return { ok: true, value: ref }
    },
    async query(input, ctx, requestedSnapshot) {
      owner.tx.assertCurrent(ctx)
      if (
        !complete ||
        canonicalJsonDigest(input.scopeRef) !== canonicalJsonDigest(ctx.scope) ||
        input.cursor !== null
      )
        return failure('usage_read_incomplete')
      owner.db.exec('BEGIN DEFERRED')
      try {
        const rows = owner.db.prepare("SELECT value FROM facts WHERE kind='fact' ORDER BY key").all() as {
          value: string
        }[]
        const actual = rows.map((row) => JSON.parse(row.value) as StoredUsageFact)
        if (
          actual.some(
            (record) =>
              canonicalJsonDigest(record.scope) !== canonicalJsonDigest(ctx.scope) ||
              canonicalJsonDigest(record.fact) !== record.ref.digest ||
              !validateRuntime('UsageFact', record.fact).ok,
          )
        )
          return failure('usage_source_proof')
        if (input.limit < actual.length) return failure('restricted_snapshot_page_unavailable')
        const snapshot = `usage-cut-${canonicalJsonDigest(actual.map((record) => record.ref))}`
        if (requestedSnapshot !== undefined && requestedSnapshot !== snapshot)
          return failure('usage_snapshot_unavailable')
        owner.tx.assertCurrent(ctx)
        return {
          ok: true,
          value: {
            value: { items: actual.map((record) => record.fact), snapshot, nextCursor: null, complete: true },
            snapshot,
          },
        }
      } finally {
        owner.db.exec('ROLLBACK')
      }
    },
    async health() {
      return { ok: true, value: { status: closed ? 'failed' : 'ready', diagnosticIds: [] } }
    },
    async drain() {
      return {
        ok: true,
        value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
      }
    },
    async close() {
      if (!closed) {
        closed = true
        owner.close()
      }
    },
  }
  const dependencies: ScopedDependencies = {
    get: () => failure('no_dependency'),
    async openScope() {
      return { ok: true, value: dependencies }
    },
    async close() {},
  }
  const factoryContext = {
    instanceId: 'usage-instance',
    bindingId: usageContext.bindingId,
    scope: usageContext.scope,
    signal: new AbortController().signal,
  }
  return {
    owner,
    authority,
    context: usageContext,
    descriptor,
    dependencies,
    factoryContext,
    async provider() {
      const config = codec.encode({})
      if (!config.ok) throw new Error('fixture')
      const provider = await createDefaultUsageFactory(descriptor, authority, codec).create(
        config.value,
        dependencies,
        factoryContext,
      )
      if (!provider.control || !provider.query) throw new TypeError('Complete public methods are missing')
      return { ...provider, control: provider.control, query: provider.query }
    },
    operation<K extends keyof RuntimeWireTypes>(
      method: 'record' | 'query',
      name: K,
      value: RuntimeWireTypes[K],
    ) {
      return {
        target: {
          bindingId: usageContext.bindingId,
          contract: 'agh.usage',
          logicalName: 'usage',
          providerId: descriptor.providerId,
        },
        method,
        input: inline(refs[method].input, name, value),
      }
    },
    incomplete: () => {
      complete = false
    },
    afterPublish: (fn: () => void) => {
      afterPublish = fn
    },
  }
}

describe('default Usage public provider with original persisted sources', () => {
  it('records a real source through official methods and returns identical refs on cold replay', async () => {
    const f = fixture(),
      value = usageMeasurement()
    f.owner.observe(value)
    const p = await f.provider(),
      input = f.operation('record', 'UsageRecordRequest', usageRequest(value)),
      first = await p.control(input, f.context)
    expect(first.ok).toBe(true)
    const file = f.owner.file
    await p.close('shutdown')
    const cold = fixture(file),
      reopened = await cold.provider()
    expect(await reopened.control(input, cold.context)).toEqual(first)
    expect(cold.owner.count()).toBe(1)
    await reopened.close('shutdown')
  })
  it('queries only complete authoritative sources and refuses damaged facts or unsupported pages rather than faking completeness', async () => {
    const f = fixture(),
      value = usageMeasurement()
    f.owner.observe(value)
    const p = await f.provider()
    const created = await p.control(
      f.operation('record', 'UsageRecordRequest', usageRequest(value)),
      f.context,
    )
    expect(created.ok).toBe(true)
    const input = f.operation('query', 'UsageQueryRequest', {
        scopeRef: f.context.scope,
        cursor: null,
        limit: 100,
      }),
      result = await p.query(input, f.context)
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.kind !== 'value' || result.value.output.kind !== 'inline')
      throw new Error('fixture')
    expect(result.value.output.value).toMatchObject({
      complete: true,
      nextCursor: null,
      items: [{ actionId: 'action', attemptId: 'attempt' }],
    })
    expect(f.owner.count()).toBe(1)
    const row = f.owner.db.prepare("SELECT key,value FROM facts WHERE kind='fact'").get() as {
      key: string
      value: string
    }
    const original = JSON.parse(row.value) as StoredUsageFact
    f.owner.put('fact', row.key, { ...original, fact: { ...original.fact, certainty: 'unknown' } })
    expect(await p.query(input, f.context)).toMatchObject({
      ok: false,
      error: { detailCode: 'usage_source_proof' },
    })
    await p.close('shutdown')
  })
  it('does not expose facts after scope or current qualification changes during publication', async () => {
    const f = fixture(),
      value = usageMeasurement()
    f.owner.observe(value)
    const p = await f.provider()
    await p.control(f.operation('record', 'UsageRecordRequest', usageRequest(value)), f.context)
    const input = f.operation('query', 'UsageQueryRequest', {
      scopeRef: { ...usageScope, workspaceId: 'other' },
      cursor: null,
      limit: 100,
    })
    expect((await p.query(input, f.context)).ok).toBe(false)
    f.afterPublish(() => f.owner.revoke())
    expect(
      (
        await p.query(
          f.operation('query', 'UsageQueryRequest', { scopeRef: f.context.scope, cursor: null, limit: 100 }),
          f.context,
        )
      ).ok,
    ).toBe(false)
    await p.close('shutdown')
  })
  it('rejects a source realm that is explicitly incomplete even when its database currently has no rows', async () => {
    const f = fixture(),
      p = await f.provider()
    f.incomplete()
    expect(
      await p.query(
        f.operation('query', 'UsageQueryRequest', { scopeRef: f.context.scope, cursor: null, limit: 100 }),
        f.context,
      ),
    ).toMatchObject({ ok: false, error: { detailCode: 'usage_read_incomplete' } })
    expect(f.owner.count()).toBe(0)
    await p.close('shutdown')
  })
})

async function contractFixture(path?: string): Promise<UsageContractFixture> {
  const f = fixture(path),
    cancel = new AbortController(),
    context = { ...f.context, signal: cancel.signal },
    config = codec.encode({})
  if (!config.ok) throw new Error('fixture config')
  const value = usageMeasurement()
  f.owner.observe(value)
  return {
    factory: createDefaultUsageFactory(f.descriptor, f.authority, codec),
    config: config.value,
    dependencies: f.dependencies,
    factoryContext: f.factoryContext,
    context,
    record: f.operation('record', 'UsageRecordRequest', usageRequest(value)),
    query: f.operation('query', 'UsageQueryRequest', { scopeRef: context.scope, cursor: null, limit: 100 }),
    async read(reference) {
      if (reference.kind !== 'inline') throw new Error('blob fixture')
      return reference.value
    },
    async facts() {
      return (
        f.owner.db.prepare("SELECT value FROM facts WHERE kind='fact' ORDER BY key").all() as {
          value: string
        }[]
      ).map((row) => {
        const body = JSON.parse(row.value) as StoredUsageFact
        const parsed = validateRuntime('UsageFact', body.fact)
        if (!parsed.ok || canonicalJsonDigest(parsed.value) !== body.ref.digest)
          throw new Error('original fact proof damaged')
        return parsed.value
      })
    },
    async deny() {
      f.owner.revoke()
    },
    cancel() {
      cancel.abort()
    },
    async recover() {
      return contractFixture(f.owner.file)
    },
    async finish() {
      await f.authority.close('shutdown')
    },
  }
}
for (const scenario of ['select', 'normal', 'deny', 'cancel', 'recover', 'dispose'] as const)
  it(`executes default Usage contract slot ${scenario} with original persistent sources`, async () => {
    await runUsageContractScenario(scenario, () => contractFixture())
  })
