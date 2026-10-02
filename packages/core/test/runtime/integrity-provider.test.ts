import { readFileSync } from 'node:fs'
import type {
  CallContext,
  EmptyAuthorConfig,
  MethodHandler,
  Outcome,
  ProviderDescriptor,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  canonicalJsonDigest,
  type DataRef,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  type SchemaRef,
  validateRuntime,
  validateRuntimeErrorDetail,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { runIntegrityContract } from '../../../extension-api/testkit/runtime/contracts/integrity.js'
import { createIntegrityFactory, createIntegrityProvider } from '../../src/runtime/providers/integrity.js'

const binding = {
  bindingId: 'integrity-binding',
  providerId: 'default.integrity',
  logicalName: 'primary',
  contract: 'agh.integrity',
}
const scope = { kind: 'runtime', installationId: 'installation', runtimeId: 'runtime' } as const
const refs = RuntimeMethodSchemaRefs['agh.integrity']
const methods = RuntimeServiceCatalog['agh.integrity'].methods
const accepted = async (): Promise<Outcome<void>> => ({ ok: true, value: undefined })
const denied = {
  ok: false,
  error: {
    code: 'denied',
    detailCode: 'permission_denied',
    message: 'denied',
    diagnosticId: 'test',
    retryAdvice: { kind: 'never' },
  },
} as const
function context(signal = new AbortController().signal): CallContext {
  return {
    bindingId: binding.bindingId,
    scope,
    principalRef: 'actor',
    authorizationRef: 'grant',
    invocationId: 'invocation',
    deadline: new Date(Date.now() + 60000).toISOString(),
    traceRef: 'trace',
    signal,
  }
}
function inline(schema: SchemaRef, value: unknown): DataRef {
  const checked = validateRuntime('JsonValue', value)
  if (!checked.ok) throw new Error('Invalid fixture JSON')
  const json = checked.value
  return {
    kind: 'inline',
    schema,
    value: json,
    bytes: Buffer.byteLength(jcs(json)),
    digest: canonicalJsonDigest(json),
  }
}
const operation = (method: keyof typeof refs, value: unknown) => ({
  target: binding,
  method,
  input: inline(refs[method].input, value),
})
function requireHandler(value: MethodHandler | undefined): MethodHandler {
  if (!value) throw new Error('Missing advertised handler')
  return value
}
const compute = (provider: ServiceProvider) => requireHandler(provider.compute)
const maintenance = (provider: ServiceProvider) => requireHandler(provider.maintenance)
const packageInput = () => {
  const ref = inline(refs.canonicalize.input, { value: null })
  return {
    manifestRef: ref,
    packageRef: ref,
    signatureRef: null,
    trustPolicyRef: 'policy',
    expectedDigest: 'a'.repeat(64),
  }
}

describe('default Integrity selected provider', () => {
  it('passes the exact public TCK without importing the reference implementation', async () => {
    const provider = createIntegrityProvider({ binding, scope, authorize: accepted })
    const evidence = await runIntegrityContract({ provider, target: binding, context })
    expect(evidence.length).toBeGreaterThan(15)
  })
  it('closes actual method envelopes and verifies exact input bytes, digest and schema identity', async () => {
    const provider = createIntegrityProvider({ binding, scope, authorize: accepted })
    const input = operation('canonicalize', { value: { text: '你好' } })
    const result = await compute(provider)(input, context())
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.kind !== 'inline') throw new Error('wrong result')
    expect(result.value.schema).toEqual(refs.canonicalize.output)
    expect(validateRuntime(methods.canonicalize.output, result.value.value).ok).toBe(true)
    for (const request of [
      { ...input, target: { ...binding, providerId: 'foreign' } },
      { ...input, input: { ...input.input, digest: '0'.repeat(64) } },
      { ...input, input: { ...input.input, bytes: 0 } },
      { ...input, input: { ...input.input, schema: refs.verify.input } },
      { ...input, method: 'verifyPackage' },
      { ...input, method: 'unknown' },
    ])
      expect((await compute(provider)(request, context())).ok).toBe(false)
    expect(
      (await compute(provider)(input, { ...context(), scope: { ...scope, runtimeId: 'foreign' } })).ok,
    ).toBe(false)
  })
  it('distinguishes unsupported format, expired/cancelled calls and inline output quota', async () => {
    const provider = createIntegrityProvider({ binding, scope, authorize: accepted })
    const unsupported = await compute(provider)(
      operation('verify', {
        kind: 'ledger-page',
        algorithm: 'unsupported',
        initial: { lastSeq: 0, legacyThroughSeq: 0, headDigest: null },
        rows: [],
      }),
      context(),
    )
    expect(unsupported.ok).toBe(false)
    if (!unsupported.ok)
      expect(unsupported.error).toMatchObject({
        code: 'incompatible',
        detailCode: 'integrity_format_unsupported',
      })
    const aborted = new AbortController()
    aborted.abort()
    expect(
      (await compute(provider)(operation('canonicalize', { value: null }), context(aborted.signal))).ok,
    ).toBe(false)
    expect(
      (
        await compute(provider)(operation('canonicalize', { value: null }), {
          ...context(),
          deadline: '2000-01-01T00:00:00Z',
        })
      ).ok,
    ).toBe(false)
    const quota = await compute(provider)(operation('canonicalize', { value: '"'.repeat(20000) }), context())
    expect(quota.ok).toBe(false)
    if (!quota.ok) expect(quota.error.code).toBe('quota')
  })
  it('returns a formally classified timeout with safe read retry before any dispatch', async () => {
    const provider = createIntegrityProvider({ binding, scope, authorize: accepted })
    const result = await compute(provider)(operation('canonicalize', { value: null }), {
      ...context(),
      deadline: '2000-01-01T00:00:00Z',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: 'timeout',
        detailCode: 'deadline_exceeded',
        retryAdvice: { kind: 'retry_read' },
      })
      expect(validateRuntimeErrorDetail(result.error).ok).toBe(true)
    }
  })
  it('does not execute request/context accessors or return content after current authorization changes', async () => {
    let current = true
    const provider = createIntegrityProvider({
      binding,
      scope,
      authorize: async () => {
        if (!current) return denied
        current = false
        return { ok: true, value: undefined }
      },
    })
    expect((await compute(provider)(operation('canonicalize', { value: 'secret' }), context())).ok).toBe(
      false,
    )
    const getterProvider = createIntegrityProvider({ binding, scope, authorize: accepted })
    let reads = 0
    const input = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        reads++
        return 'secret'
      },
    })
    const ctx = Object.defineProperty(context(), 'authorizationRef', {
      enumerable: true,
      get() {
        reads++
        return 'grant'
      },
    })
    expect(
      (
        await compute(getterProvider)(
          { target: binding, method: 'canonicalize', input: input as DataRef },
          context(),
        )
      ).ok,
    ).toBe(false)
    expect((await compute(getterProvider)(operation('canonicalize', { value: null }), ctx)).ok).toBe(false)
    expect(reads).toBe(0)
  })
  it('never treats compute permission as a maintenance grant or invokes a missing trust verifier', async () => {
    let invoked = false
    const provider = createIntegrityProvider({
      binding,
      scope,
      authorize: async (request) =>
        request.method === 'verifyPackage' ? denied : { ok: true, value: undefined },
      maintenance: {
        verifyPackage: async (input) => {
          invoked = true
          return {
            ok: true,
            value: {
              verifiedDigest: input.expectedDigest,
              signerRef: null,
              sourceEvidenceRef: input.packageRef,
              accepted: true,
            },
          }
        },
      },
    })
    expect((await compute(provider)(operation('canonicalize', { value: null }), context())).ok).toBe(true)
    expect((await maintenance(provider)(operation('verifyPackage', packageInput()), context())).ok).toBe(
      false,
    )
    expect(invoked).toBe(false)
    expect(createIntegrityProvider({ binding, scope, authorize: accepted }).maintenance).toBeUndefined()
  })
  it('uses a real typed package port, rechecks current authority and rejects dishonest accepted results', async () => {
    const provider = createIntegrityProvider({
      binding,
      scope,
      authorize: accepted,
      maintenance: {
        verifyPackage: async (input) => ({
          ok: true,
          value: {
            verifiedDigest: input.expectedDigest,
            signerRef: null,
            sourceEvidenceRef: input.packageRef,
            accepted: true,
          },
        }),
      },
    })
    expect((await maintenance(provider)(operation('verifyPackage', packageInput()), context())).ok).toBe(true)
    const bad = createIntegrityProvider({
      binding,
      scope,
      authorize: accepted,
      maintenance: {
        verifyPackage: async (input) => ({
          ok: true,
          value: {
            verifiedDigest: 'b'.repeat(64),
            signerRef: null,
            sourceEvidenceRef: input.packageRef,
            accepted: true,
          },
        }),
      },
    })
    expect((await maintenance(bad)(operation('verifyPackage', packageInput()), context())).ok).toBe(false)
    let current = true
    const revoked = createIntegrityProvider({
      binding,
      scope,
      authorize: async () => (current ? { ok: true, value: undefined } : denied),
      maintenance: {
        verifyPackage: async (input) => {
          current = false
          return {
            ok: true,
            value: {
              verifiedDigest: input.expectedDigest,
              signerRef: null,
              sourceEvidenceRef: input.packageRef,
              accepted: true,
            },
          }
        },
      },
    })
    expect((await maintenance(revoked)(operation('verifyPackage', packageInput()), context())).ok).toBe(false)
  })
  it('cancels an actual active maintenance job, blocks new admissions during drain and closes idempotently', async () => {
    let notify: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      notify = resolve
    })
    const provider = createIntegrityProvider({
      binding,
      scope,
      authorize: accepted,
      maintenance: {
        verifyPackage: (_input, call) =>
          new Promise((resolve) => {
            notify()
            call.signal.addEventListener(
              'abort',
              () =>
                resolve({
                  ok: false,
                  error: {
                    code: 'cancelled',
                    detailCode: 'cancelled',
                    message: 'cancelled',
                    diagnosticId: 'test',
                    retryAdvice: { kind: 'never' },
                  },
                }),
              { once: true },
            )
          }),
      },
    })
    const pending = maintenance(provider)(operation('verifyPackage', packageInput()), context())
    await entered
    const drain = await provider.drain(new Date().toISOString(), context())
    expect(drain.ok && drain.value.state).toBe('blocked')
    expect((await compute(provider)(operation('canonicalize', { value: null }), context())).ok).toBe(false)
    await provider.close('shutdown')
    await provider.close('shutdown')
    expect((await pending).ok).toBe(false)
  })
})

describe('default Integrity descriptor factory', () => {
  const {
    $id: _id,
    $schema: _schema,
    ...schema
  } = JSON.parse(
    readFileSync(
      new URL('../../../protocol/schema/runtime/empty-config.schema.json', import.meta.url),
      'utf8',
    ),
  )
  schema.required ??= []
  const codec = defineGeneratedAuthorSchema<EmptyAuthorConfig>({
    ownerPackageId: 'fixture.integrity',
    name: 'Empty',
    typeId: 'fixture.integrity/empty@1',
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Empty',
      $defs: { Empty: schema },
    },
  })
  const descriptor: ProviderDescriptor = {
    providerId: binding.providerId,
    contract: binding.contract,
    logicalName: binding.logicalName,
    major: 1,
    packageVersion: '1.0.0',
    packageDigest: 'a'.repeat(64),
    features: [],
    scope: 'runtime',
    configSchema: codec.ref,
    requires: [],
    capabilities: [],
    recovery: 'R0',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: (['canonicalize', 'verify'] as const).map((method) => ({
      method,
      kind: 'compute' as const,
      inputSchema: refs[method].input,
      outputSchema: refs[method].output,
      requiredCapabilities: [],
      retrySafety: 'read-only' as const,
    })),
  }
  const dependencies: ScopedDependencies = {
    get: () => {
      throw new Error('no hidden Integrity dependency')
    },
    openScope: async () => {
      throw new Error('no hidden scope')
    },
    close: async () => undefined,
  }
  it('creates a selected instance only from the exact generated empty configuration source', async () => {
    const factory = createIntegrityFactory({ descriptor, configSchema: codec, authorize: accepted })
    const encoded = codec.encode({})
    if (!encoded.ok) throw new Error('config encode failed')
    const factoryContext = {
      instanceId: 'instance',
      scope,
      bindingId: binding.bindingId,
      signal: new AbortController().signal,
    }
    const provider = await factory.create(encoded.value, dependencies, factoryContext)
    expect((await compute(provider)(operation('canonicalize', { value: 1 }), context())).ok).toBe(true)
    for (const input of [
      { ...encoded.value, schema: { ...codec.ref, digest: '0'.repeat(64) } },
      { ...encoded.value, bytes: 1 },
      inline(codec.ref, { extra: true }),
    ])
      await expect(factory.create(input, dependencies, factoryContext)).rejects.toThrow()
  })
  it('refuses unknown/duplicate/wrong-ref methods and advertised maintenance without a real owner', () => {
    const packageDescriptor = {
      method: 'verifyPackage',
      kind: 'maintenance' as const,
      inputSchema: refs.verifyPackage.input,
      outputSchema: refs.verifyPackage.output,
      requiredCapabilities: [],
      retrySafety: 'read-only' as const,
    }
    for (const operations of [
      [...descriptor.operations, packageDescriptor],
      [...descriptor.operations, { ...packageDescriptor, method: 'unknown' }],
      [...descriptor.operations, descriptor.operations[0] as ProviderDescriptor['operations'][number]],
      descriptor.operations.map((operation) => ({ ...operation, inputSchema: refs.verifyPackage.input })),
    ])
      expect(() =>
        createIntegrityFactory({
          descriptor: { ...descriptor, operations },
          configSchema: codec,
          authorize: accepted,
        }),
      ).toThrow()
  })
})
