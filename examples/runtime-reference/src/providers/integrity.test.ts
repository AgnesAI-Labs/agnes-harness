import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
  type CommitMutationManifest,
  type CommitSideEntry,
  canonicalJsonDigest,
  type DataRef,
  type IntegrityVerifyRequest,
  type LedgerIntegrityRow,
  type OwnerRef,
  RuntimeMethodSchemaRefs,
  type SchemaRef,
  type ServiceOperation,
  validateRuntime,
  validateRuntimeErrorDetail,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { runIntegrityContract } from '../../../../packages/extension-api/testkit/runtime/contracts/integrity.js'
import {
  createReferenceIntegrityFactory,
  createReferenceIntegrityProvider,
  type ReferenceIntegrityTransferPort,
} from './integrity.js'
import { referenceCanonicalize, referenceVerify } from './integrity-algorithms.js'

function present<T>(value: T | undefined | null): T {
  if (value == null) throw new Error('Missing fixture or advertised handler')
  return value
}
function compute(provider: ServiceProvider): MethodHandler {
  return present(provider.compute)
}
const digest = (value: unknown): string => createHash('sha256').update(jcs(value)).digest('hex')
const zero = { lastSeq: 0, legacyThroughSeq: 0, headDigest: null }
const event = (seq: number): LedgerIntegrityRow['event'] => ({
  seq,
  ts: '2026-10-01T00:00:00Z',
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  type: 'turn/start',
  data: {},
  actor: { id: 'actor', org: 'org', role: 'user', deptPath: [], attrs: {} },
  origin: 'principal',
  trust: 'trusted',
})
function protectedRow(seq: number, owner: string, previous: string | null, legacy = 0): LedgerIntegrityRow {
  const mode = previous === null ? 'anchor' : 'chain'
  const body =
    previous === null
      ? {
          algorithm: 'agnes-ledger-jcs-sha256-v1',
          sessionKey: owner,
          legacyThroughSeq: legacy,
          event: event(seq),
        }
      : {
          algorithm: 'agnes-ledger-jcs-sha256-v1',
          sessionKey: owner,
          previousDigest: previous,
          event: event(seq),
        }
  return {
    sessionKey: owner,
    event: event(seq),
    integrity: { mode, previousDigest: previous, digest: digest(body) },
  }
}
const page = (rows: LedgerIntegrityRow[], initial = zero): IntegrityVerifyRequest => ({
  kind: 'ledger-page',
  algorithm: 'agnes-ledger-jcs-sha256-v1',
  initial,
  rows,
})
const next = {
  recordRevision: 1,
  schema: { typeId: 'test/record@1', revision: 1, digest: 'a'.repeat(64) },
  digest: 'b'.repeat(64),
}
function manifest(
  mutations: CommitMutationManifest[] = [],
  sideEntries: CommitSideEntry[] = [],
): Extract<IntegrityVerifyRequest, { kind: 'commit-manifest' }> {
  const counts = { createdActions: 0, consumedSignals: 0, outboxEvents: 0, receipts: 0, usageOrigins: 0 }
  for (const side of sideEntries) {
    const field = {
      'action-created': 'createdActions',
      'signal-consumed': 'consumedSignals',
      'outbox-created': 'outboxEvents',
      'receipt-created': 'receipts',
      'usage-origin': 'usageOrigins',
    } as const
    counts[field[side.kind]]++
  }
  return {
    kind: 'commit-manifest',
    mutations,
    sideEntries,
    commit: {
      commitId: 'commit',
      transactionFingerprint: 'a'.repeat(64),
      runId: null,
      actionId: null,
      authorityEpoch: 1,
      writerEpoch: 1,
      previousCommitId: null,
      mutationsDigest: digest(mutations.map(({ commitId: _id, ...body }) => body)),
      sideListsDigest: digest(sideEntries.map(({ commitId: _id, ...body }) => body)),
      mutationCount: mutations.length,
      counts,
    },
  }
}
const binding = {
  bindingId: 'integrity-binding',
  contract: 'agh.integrity',
  logicalName: 'primary',
  providerId: 'reference.integrity',
}
const scope = { kind: 'runtime', installationId: 'installation', runtimeId: 'runtime' } as const
function context(signal = new AbortController().signal): CallContext {
  return {
    principalRef: 'actor',
    scope,
    bindingId: binding.bindingId,
    invocationId: 'call',
    deadline: new Date(Date.now() + 60000).toISOString(),
    traceRef: 'trace',
    authorizationRef: 'grant',
    signal,
  }
}
function inline(schema: SchemaRef, value: unknown): DataRef {
  const json = JSON.parse(jcs(value))
  return {
    kind: 'inline',
    schema,
    value: json,
    digest: canonicalJsonDigest(json),
    bytes: Buffer.byteLength(jcs(value)),
  }
}
const invoke = (method: 'canonicalize' | 'verify' | 'verifyPackage', value: unknown) => ({
  target: binding,
  method,
  input: inline(RuntimeMethodSchemaRefs['agh.integrity'][method].input, value),
})
const ok = async (): Promise<Outcome<void>> => ({ ok: true, value: undefined })

describe('independent integrity algorithms', () => {
  it('uses the existing JCS hash and UTF8 byte length, including negative JSON zero', () => {
    const value = { z: '😀', a: -0 }
    expect(referenceCanonicalize({ value })).toEqual({
      canonical: '{"a":0,"z":"😀"}',
      digest: digest(value),
      bytes: Buffer.byteLength(jcs(value)),
    })
    expect(referenceCanonicalize({ value: null }).digest).toBe(
      '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
    )
  })
  it.each([NaN, Infinity, new Date(), new Map(), '\ud800', () => 1])(
    'rejects a noncanonical value without laundering it (%s)',
    (value) => expect(() => referenceCanonicalize({ value })).toThrow(),
  )
  it('rejects getters without executing and rejects cycles and unknown fields', () => {
    let reads = 0
    const value = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        reads++
        return 1
      },
    })
    expect(() => referenceCanonicalize({ value })).toThrow()
    expect(reads).toBe(0)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const input of [{ value: cyclic }, { value: 1, extra: true }, {}])
      expect(() => referenceCanonicalize(input)).toThrow()
  })
  it('preserves legacy/anchor/chain and parent-prefix physical owners across page boundaries', () => {
    const legacy: LedgerIntegrityRow = { sessionKey: 'parent'.repeat(100), event: event(1), integrity: null }
    const anchor = protectedRow(2, legacy.sessionKey, null, 1)
    const chained = protectedRow(3, 'child', anchor.integrity?.digest ?? '')
    const first = referenceVerify(page([legacy, anchor]))
    expect(first).toEqual({
      kind: 'ledger-page',
      checkpoint: { lastSeq: 2, legacyThroughSeq: 1, headDigest: anchor.integrity?.digest },
    })
    if (first.kind !== 'ledger-page') throw new Error('wrong branch')
    expect(referenceVerify({ ...page([chained]), initial: first.checkpoint })).toEqual(
      referenceVerify(page([legacy, anchor, chained])),
    )
  })
  it('rejects sequence gaps/duplicates, modified owners/events, reanchor, legacy after protection and bad predecessor', () => {
    const first = protectedRow(1, 'parent', null)
    const second = protectedRow(2, 'child', first.integrity?.digest ?? '')
    const invalid = [
      [first, first],
      [second],
      [{ ...first, sessionKey: 'changed' }],
      [{ ...first, event: event(2) }],
      [first, protectedRow(2, 'child', null)],
      [first, { sessionKey: 'child', event: event(2), integrity: null }],
      [first, { ...second, integrity: { ...present(second.integrity), previousDigest: '0'.repeat(64) } }],
    ]
    for (const rows of invalid) expect(() => referenceVerify(page(rows))).toThrow()
  })
  it('checks checkpoint relationships and -0 without pretending the initial head is trusted', () => {
    for (const initial of [
      { lastSeq: 1, legacyThroughSeq: 2, headDigest: null },
      { lastSeq: 2, legacyThroughSeq: 1, headDigest: null },
      { ...zero, lastSeq: -0 },
    ])
      expect(() => referenceVerify({ ...page([]), initial })).toThrow()
    const claimed = { lastSeq: 10, legacyThroughSeq: 0, headDigest: 'a'.repeat(64) }
    expect(referenceVerify({ ...page([]), initial: claimed })).toEqual({
      kind: 'ledger-page',
      checkpoint: claimed,
    })
  })
  it('accepts selfconsistent material without granting provenance', () => {
    const selfSigned = protectedRow(1, 'caller-owner', null)
    expect(referenceVerify(page([selfSigned])).kind).toBe('ledger-page')
  })
  it('accepts all five sorted side kinds, create/update/delete and empty-array digests', () => {
    const mutations: CommitMutationManifest[] = [
      { commitId: 'commit', recordId: 'a', previousRevision: null, next },
      { commitId: 'commit', recordId: 'b', previousRevision: 1, next: { ...next, recordRevision: 2 } },
      { commitId: 'commit', recordId: 'c', previousRevision: 2, next: null },
    ]
    const sides: CommitSideEntry[] = [
      { commitId: 'commit', kind: 'action-created', actionId: 'a' },
      { commitId: 'commit', kind: 'outbox-created', eventId: 'e' },
      { commitId: 'commit', kind: 'receipt-created', receiptId: 'r' },
      { commitId: 'commit', kind: 'signal-consumed', signalId: 's' },
      { commitId: 'commit', kind: 'usage-origin', sourceAuthorityId: 'u', originKey: 'o' },
    ]
    expect(referenceVerify(manifest(mutations, sides))).toMatchObject({
      kind: 'commit-manifest',
      commitId: 'commit',
    })
    expect(referenceVerify(manifest())).toMatchObject({
      mutationsDigest: digest([]),
      sideListsDigest: digest([]),
    })
  })
  it('uses UTF8 ordering rather than UTF16 and tuple identities rather than joined keys', () => {
    const make = (recordId: string): CommitMutationManifest => ({
      commitId: 'commit',
      recordId,
      previousRevision: null,
      next,
    })
    expect(referenceVerify(manifest([make('\ue000'), make('😀')])).kind).toBe('commit-manifest')
    expect(() => referenceVerify(manifest([make('😀'), make('\ue000')]))).toThrow()
    const sides: CommitSideEntry[] = [
      { commitId: 'commit', kind: 'usage-origin', sourceAuthorityId: 'a', originKey: 'bc' },
      { commitId: 'commit', kind: 'usage-origin', sourceAuthorityId: 'ab', originKey: 'c' },
    ]
    expect(referenceVerify(manifest([], sides)).kind).toBe('commit-manifest')
  })
  it('rejects duplicate, wrong-commit, wrong-count/hash and invalid revision relations even when rehashed', () => {
    const row: CommitMutationManifest = { commitId: 'commit', recordId: 'a', previousRevision: null, next }
    for (const mutations of [
      [row, row],
      [{ ...row, commitId: 'other' }],
      [{ ...row, next: null }],
      [{ ...row, previousRevision: 0 }],
      [{ ...row, next: { ...next, recordRevision: 2 } }],
      [
        {
          ...row,
          previousRevision: Number.MAX_SAFE_INTEGER,
          next: { ...next, recordRevision: Number.MAX_SAFE_INTEGER },
        },
      ],
    ])
      expect(() => referenceVerify(manifest(mutations))).toThrow()
    const good = manifest([row])
    for (const commit of [
      { ...good.commit, mutationCount: 2 },
      { ...good.commit, mutationsDigest: '0'.repeat(64) },
      { ...good.commit, counts: { ...good.commit.counts, receipts: 1 } },
    ])
      expect(() => referenceVerify({ ...good, commit })).toThrow()
    const side: CommitSideEntry = { commitId: 'commit', kind: 'action-created', actionId: 'a' }
    expect(() => referenceVerify(manifest([], [side, side]))).toThrow()
    expect(() => referenceVerify(manifest([], [{ ...side, commitId: 'other' }]))).toThrow()
  })
  it('enforces 500-row and per-RPC work limits without partial success', () => {
    const rows = Array.from(
      { length: 500 },
      (_, index): LedgerIntegrityRow => ({ sessionKey: 'legacy', event: event(index + 1), integrity: null }),
    )
    // This complete page also exceeds the separate shared member-work budget.
    expect(() => referenceVerify(page([...rows, present(rows[0])]))).toThrow()
    expect(() => referenceVerify({ ...manifest(), mutations: Array(10001).fill({}) })).toThrow()
    expect(() => referenceCanonicalize({ value: 'x'.repeat(1048576) })).toThrow()
  })
})

describe('reference selected Integrity service consumer', () => {
  it('passes the public Integrity TCK through actual method requests', async () => {
    const provider = createReferenceIntegrityProvider({ binding, scope, authorize: ok })
    const evidence = await runIntegrityContract({ provider, context, target: binding })
    expect(evidence.length).toBeGreaterThan(15)
  })
  it('executes real compute through method codecs and returns the exact official output ref', async () => {
    const provider = createReferenceIntegrityProvider({ binding, scope, authorize: ok })
    const result = await compute(provider)(invoke('canonicalize', { value: { hello: '😀' } }), context())
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.kind !== 'inline') throw new Error('expected inline result')
    expect(result.value.schema).toEqual(RuntimeMethodSchemaRefs['agh.integrity'].canonicalize.output)
    expect(validateRuntime('IntegrityCanonicalizeResult', result.value.value).ok).toBe(true)
    expect(result.value.digest).toBe(canonicalJsonDigest(result.value.value))
    expect(result.value.bytes).toBe(Buffer.byteLength(jcs(result.value.value)))
    expect((await compute(provider)(invoke('verify', manifest()), context())).ok).toBe(true)
  })
  it('rejects wrong target, input schema/digest/bytes, unknown compute, maintenance laundering and foreign scope', async () => {
    const provider = createReferenceIntegrityProvider({ binding, scope, authorize: ok })
    const good = invoke('canonicalize', { value: null })
    const bad = [
      { ...good, target: { ...binding, providerId: 'other' } },
      { ...good, method: 'verifyPackage' },
      { ...good, method: 'unknown' },
      { ...good, input: { ...good.input, digest: '0'.repeat(64) } },
      { ...good, input: { ...good.input, bytes: 1 } },
      { ...good, input: { ...good.input, schema: RuntimeMethodSchemaRefs['agh.integrity'].verify.input } },
    ]
    for (const request of bad) expect((await compute(provider)(request, context())).ok).toBe(false)
    expect(
      (await compute(provider)(good, { ...context(), scope: { ...scope, runtimeId: 'foreign' } })).ok,
    ).toBe(false)
    expect(provider.maintenance).toBeUndefined()
  })
  it('performs latest authorization and cancellation after asynchronous dependencies', async () => {
    let calls = 0
    const provider = createReferenceIntegrityProvider({
      binding,
      scope,
      authorize: async () =>
        ++calls === 1
          ? { ok: true, value: undefined }
          : {
              ok: false,
              error: {
                code: 'denied',
                detailCode: 'permission_denied',
                message: 'denied',
                retryAdvice: { kind: 'never' },
                diagnosticId: 'test',
              },
            },
    })
    expect((await compute(provider)(invoke('canonicalize', { value: null }), context())).ok).toBe(false)
    expect(calls).toBe(2)
    const controller = new AbortController()
    const cancelled = createReferenceIntegrityProvider({
      binding,
      scope,
      authorize: async () => {
        controller.abort()
        return { ok: true, value: undefined }
      },
    })
    expect(
      (await compute(cancelled)(invoke('canonicalize', { value: null }), context(controller.signal))).ok,
    ).toBe(false)
  })
  it('does not truncate or secretly upload canonical output beyond inline budget', async () => {
    const provider = createReferenceIntegrityProvider({ binding, scope, authorize: ok })
    const result = await compute(provider)(invoke('canonicalize', { value: '"'.repeat(20000) }), context())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('quota')
  })
  it('classifies unsupported ledger algorithms through the actual provider', async () => {
    const provider = createReferenceIntegrityProvider({ binding, scope, authorize: ok })
    const result = await compute(provider)(invoke('verify', { ...page([]), algorithm: 'unknown' }), context())
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toMatchObject({ code: 'incompatible', detailCode: 'integrity_format_unsupported' })
  })
  it('uses method-specific current permission, rather than treating a compute caller as a maintenance grant', async () => {
    let invoked = false
    const ref = inline(RuntimeMethodSchemaRefs['agh.integrity'].canonicalize.input, { value: null })
    const request = {
      manifestRef: ref,
      packageRef: ref,
      expectedDigest: 'a'.repeat(64),
      signatureRef: null,
      trustPolicyRef: 'policy',
    }
    const provider = createReferenceIntegrityProvider({
      binding,
      scope,
      authorize: async (operation) =>
        operation.method === 'verifyPackage'
          ? {
              ok: false,
              error: {
                code: 'denied',
                detailCode: 'permission_denied',
                message: 'denied',
                retryAdvice: { kind: 'never' },
                diagnosticId: 'test',
              },
            }
          : { ok: true, value: undefined },
      maintenance: {
        verifyPackage: async () => {
          invoked = true
          return {
            ok: true,
            value: {
              verifiedDigest: request.expectedDigest,
              signerRef: null,
              sourceEvidenceRef: ref,
              accepted: true,
            },
          }
        },
      },
    })
    expect((await compute(provider)(invoke('canonicalize', { value: null }), context())).ok).toBe(true)
    expect((await present(provider.maintenance)(invoke('verifyPackage', request), context())).ok).toBe(false)
    expect(invoked).toBe(false)
  })
  it('does not execute CallContext getters and rejects an expired deadline', async () => {
    const provider = createReferenceIntegrityProvider({ binding, scope, authorize: ok })
    let reads = 0
    const getter = Object.defineProperty(context(), 'authorizationRef', {
      get() {
        reads++
        return 'grant'
      },
    })
    expect((await compute(provider)(invoke('canonicalize', { value: null }), getter)).ok).toBe(false)
    expect(reads).toBe(0)
    const expired = await compute(provider)(invoke('canonicalize', { value: null }), {
      ...context(),
      deadline: '2000-01-01T00:00:00Z',
    })
    expect(expired.ok).toBe(false)
    if (!expired.ok) {
      expect(validateRuntimeErrorDetail(expired.error).ok).toBe(true)
      expect(expired.error).toMatchObject({
        code: 'timeout',
        detailCode: 'deadline_exceeded',
        retryAdvice: { kind: 'retry_read' },
      })
      expect(
        validateRuntimeErrorDetail({ ...expired.error, code: 'cancelled', retryAdvice: { kind: 'never' } })
          .ok,
      ).toBe(false)
    }
  })
  it('keeps trusted package verification out of compute and validates its real typed output', async () => {
    let uses = 0
    const ref = inline(RuntimeMethodSchemaRefs['agh.integrity'].canonicalize.input, { value: null })
    const request = {
      manifestRef: ref,
      packageRef: ref,
      expectedDigest: 'a'.repeat(64),
      signatureRef: null,
      trustPolicyRef: 'policy',
    }
    const provider = createReferenceIntegrityProvider({
      binding,
      scope,
      authorize: ok,
      maintenance: {
        verifyPackage: async () => {
          uses++
          return {
            ok: true,
            value: {
              verifiedDigest: request.expectedDigest,
              signerRef: null,
              sourceEvidenceRef: ref,
              accepted: true,
            },
          }
        },
      },
    })
    expect((await compute(provider)(invoke('verifyPackage', request), context())).ok).toBe(false)
    expect(uses).toBe(0)
    expect((await present(provider.maintenance)(invoke('verifyPackage', request), context())).ok).toBe(true)
    expect(uses).toBe(1)
  })
  it('drains without new admissions and cancels a live trusted maintenance call on close', async () => {
    const provider = createReferenceIntegrityProvider({ binding, scope, authorize: ok })
    expect((await provider.drain(new Date().toISOString(), context())).ok).toBe(true)
    expect((await compute(provider)(invoke('canonicalize', { value: null }), context())).ok).toBe(false)
    await provider.close('shutdown')
    await provider.close('shutdown')
  })
})

describe('reference Integrity generated configuration factory', () => {
  const {
    $schema: _schema,
    $id: _id,
    ...emptySchema
  } = JSON.parse(
    readFileSync(
      new URL('../../../../packages/protocol/schema/runtime/empty-config.schema.json', import.meta.url),
      'utf8',
    ),
  )
  emptySchema.required ??= []
  const codec = defineGeneratedAuthorSchema<EmptyAuthorConfig>({
    ownerPackageId: 'fixture.integrity',
    name: 'EmptyIntegrityConfig',
    typeId: 'fixture.integrity/empty-integrity-config@1',
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/EmptyIntegrityConfig',
      $defs: { EmptyIntegrityConfig: emptySchema },
    },
  })
  const descriptor: ProviderDescriptor = {
    providerId: binding.providerId,
    contract: 'agh.integrity',
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
      inputSchema: RuntimeMethodSchemaRefs['agh.integrity'][method].input,
      outputSchema: RuntimeMethodSchemaRefs['agh.integrity'][method].output,
      requiredCapabilities: [],
      retrySafety: 'read-only' as const,
    })),
  }
  const dependencies: ScopedDependencies = {
    get: () => {
      throw new Error('pure Integrity must not fetch hidden dependencies')
    },
    openScope: async () => {
      throw new Error('pure Integrity must not open hidden scopes')
    },
    close: async () => undefined,
  }
  it('uses the exact deployed generated codec and rejects changed config identity, content or bytes', async () => {
    const validDescriptor = validateRuntime('ProviderDescriptor', descriptor)
    if (!validDescriptor.ok) throw new Error(JSON.stringify(validDescriptor.errors))
    const factory = createReferenceIntegrityFactory({ descriptor, configSchema: codec, authorize: ok })
    const encoded = codec.encode({})
    if (!encoded.ok) throw new Error('config encode failed')
    const factoryContext = {
      instanceId: 'instance',
      scope,
      bindingId: binding.bindingId,
      signal: new AbortController().signal,
    }
    const provider = await factory.create(encoded.value, dependencies, factoryContext)
    expect((await compute(provider)(invoke('canonicalize', { value: 1 }), context())).ok).toBe(true)
    for (const data of [
      { ...encoded.value, schema: { ...codec.ref, digest: '0'.repeat(64) } },
      { ...encoded.value, bytes: 1 },
      inline(codec.ref, { extra: true }),
    ])
      await expect(factory.create(data, dependencies, factoryContext)).rejects.toThrow()
    expect(() =>
      createReferenceIntegrityFactory({
        descriptor: { ...descriptor, configSchema: { ...codec.ref, revision: 2 } },
        configSchema: codec,
        authorize: ok,
      }),
    ).toThrow()
  })
  it('refuses unadvertised maintenance, wrong method refs and missing advertised trusted ports', () => {
    const verifyPackage = {
      method: 'verifyPackage',
      kind: 'maintenance' as const,
      inputSchema: RuntimeMethodSchemaRefs['agh.integrity'].verifyPackage.input,
      outputSchema: RuntimeMethodSchemaRefs['agh.integrity'].verifyPackage.output,
      requiredCapabilities: [],
      retrySafety: 'read-only' as const,
    }
    expect(() =>
      createReferenceIntegrityFactory({
        descriptor: { ...descriptor, operations: [...descriptor.operations, verifyPackage] },
        configSchema: codec,
        authorize: ok,
      }),
    ).toThrow()
    expect(() =>
      createReferenceIntegrityFactory({
        descriptor: {
          ...descriptor,
          operations: [
            {
              ...present(descriptor.operations[0]),
              outputSchema: RuntimeMethodSchemaRefs['agh.integrity'].verify.output,
            },
            present(descriptor.operations[1]),
          ],
        },
        configSchema: codec,
        authorize: ok,
      }),
    ).toThrow()
  })
})

describe('reference Integrity active maintenance lifecycle', () => {
  it('blocks drain while actual work is pending and aborts that work on close', async () => {
    let entered: () => void = () => undefined
    const entry = new Promise<void>((resolve) => {
      entered = resolve
    })
    const ref = inline(RuntimeMethodSchemaRefs['agh.integrity'].canonicalize.input, { value: null })
    const request = {
      manifestRef: ref,
      packageRef: ref,
      expectedDigest: 'a'.repeat(64),
      signatureRef: null,
      trustPolicyRef: 'policy',
    }
    const provider = createReferenceIntegrityProvider({
      binding,
      scope,
      authorize: ok,
      maintenance: {
        verifyPackage: (_request, call) =>
          new Promise((resolve) => {
            entered()
            call.signal.addEventListener(
              'abort',
              () =>
                resolve({
                  ok: false,
                  error: {
                    code: 'cancelled',
                    detailCode: 'cancelled',
                    message: 'cancelled',
                    retryAdvice: { kind: 'never' },
                    diagnosticId: 'test',
                  },
                }),
              { once: true },
            )
          }),
      },
    })
    const pending = present(provider.maintenance)(invoke('verifyPackage', request), context())
    await entry
    const drained = await provider.drain(new Date().toISOString(), context())
    expect(drained.ok && drained.value.state).toBe('blocked')
    expect((await compute(provider)(invoke('canonicalize', { value: null }), context())).ok).toBe(false)
    await provider.close('shutdown')
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('cancelled')
  })
  it('rejects an accepted trusted package result whose digest differs from the requested digest', async () => {
    const ref = inline(RuntimeMethodSchemaRefs['agh.integrity'].canonicalize.input, { value: null })
    const request = {
      manifestRef: ref,
      packageRef: ref,
      expectedDigest: 'a'.repeat(64),
      signatureRef: null,
      trustPolicyRef: 'policy',
    }
    const provider = createReferenceIntegrityProvider({
      binding,
      scope,
      authorize: ok,
      maintenance: {
        verifyPackage: async () => ({
          ok: true,
          value: { verifiedDigest: 'b'.repeat(64), signerRef: null, sourceEvidenceRef: ref, accepted: true },
        }),
      },
    })
    expect((await present(provider.maintenance)(invoke('verifyPackage', request), context())).ok).toBe(false)
  })
})

type TransferMode = 'normal' | 'abort' | 'late-deny' | 'bad-output' | 'throw' | 'failed' | 'failed-reconcile'
function transferFixture(mode: TransferMode = 'normal') {
  const directory = mkdtempSync(join(tmpdir(), 'integrity-transfer-owner-'))
  const path = join(directory, 'owner.sqlite')
  const db = new DatabaseSync(path)
  db.exec(
    'PRAGMA synchronous=FULL; CREATE TABLE requests(id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, body TEXT); CREATE TABLE permissions(auth TEXT PRIMARY KEY, actor TEXT NOT NULL, revoked INTEGER NOT NULL)',
  )
  db.prepare('INSERT INTO permissions VALUES(?,?,0)').run('grant', 'actor')
  const controller = new AbortController()
  let effects = 0
  const allowed = (call: CallContext) => {
    const row = db.prepare('SELECT * FROM permissions WHERE auth=?').get(call.authorizationRef)
    return (
      row?.actor === call.principalRef &&
      row.revoked === 0 &&
      call.bindingId === binding.bindingId &&
      jcs(call.scope) === jcs(scope)
    )
  }
  const denied = (): Outcome<never> => ({
    ok: false,
    error: {
      code: 'denied',
      detailCode: 'permission_denied',
      message: 'owner refuses',
      diagnosticId: 'fixture',
      retryAdvice: { kind: 'never' },
    },
  })
  const fingerprint = (operation: ServiceOperation) => canonicalJsonDigest(operation)
  const identity = (operation: ServiceOperation, call: CallContext) => {
    if (operation.input.kind !== 'inline') throw new Error('fixture expects decoded inline request')
    const input = validateRuntime('AuthorityTransferControlAbortRequest', operation.input.value)
    if (!input.ok) throw new Error('invalid actual fixture input')
    return canonicalJsonDigest({
      target: operation.target,
      method: operation.method,
      upgradeId: input.value.upgradeId,
      principalRef: call.principalRef,
      bindingId: call.bindingId,
      scope: call.scope,
    })
  }
  const original = inline(RuntimeMethodSchemaRefs['agh.integrity'].authorityAbort.output, {
    state: 'aborted',
    source: { authorityId: 'authority', tenantId: 'tenant', authorityEpoch: 1 },
    restoredEpoch: 2,
  })
  const matches = (operation: ServiceOperation, owner: OwnerRef, call: CallContext) => {
    const row = db.prepare('SELECT * FROM requests WHERE id=?').get(owner.id)
    return allowed(call) &&
      !call.signal.aborted &&
      owner.kind === 'reconciliation' &&
      row?.identity === identity(operation, call) &&
      row.fingerprint === fingerprint(operation)
      ? row
      : undefined
  }
  const port: ReferenceIntegrityTransferPort = {
    descriptor: { binding, scope, feature: 'authority-transfer.v1', methods: ['authorityAbort'] },
    async prepare(operation, call) {
      if (!allowed(call) || call.signal.aborted) return denied()
      const key = identity(operation, call)
      const old = db.prepare('SELECT id,fingerprint FROM requests WHERE identity=?').get(key)
      if (old)
        return old.fingerprint === fingerprint(operation) && typeof old.id === 'string'
          ? { ok: true, value: { kind: 'reconciliation', id: old.id } }
          : denied()
      const id = randomUUID()
      db.prepare('INSERT INTO requests VALUES(?,?,?,NULL)').run(id, key, fingerprint(operation))
      return { ok: true, value: { kind: 'reconciliation', id } }
    },
    async execute(operation, owner, call) {
      const old = matches(operation, owner, call)
      if (!old) return denied()
      if (typeof old.body === 'string') return { ok: true, value: JSON.parse(old.body) as DataRef }
      db.exec('BEGIN IMMEDIATE')
      db.prepare('UPDATE requests SET body=? WHERE id=?').run(jcs(original), owner.id)
      db.exec('COMMIT')
      effects++
      if (mode === 'abort') controller.abort()
      if (mode === 'late-deny') db.exec('UPDATE permissions SET revoked=1')
      if (mode === 'throw') throw new Error('lost committed reply')
      if (mode === 'failed' || mode === 'failed-reconcile') return denied()
      return { ok: true, value: mode === 'bad-output' ? { ...original, bytes: 0 } : original }
    },
    async reconcile(operation, owner, call) {
      const row = matches(operation, owner, call)
      if (!row || typeof row.body !== 'string') return denied()
      const saved = JSON.parse(row.body) as DataRef
      return { ok: true, value: mode === 'failed-reconcile' ? { ...saved, bytes: 0 } : saved }
    },
  }
  const value = {
    upgradeId: 'upgrade',
    expectedFenceId: 'fence',
    recoveryRoute: inline(RuntimeMethodSchemaRefs['agh.integrity'].canonicalize.input, { value: null }),
  }
  const operation: ServiceOperation = {
    target: binding,
    method: 'authorityAbort',
    input: inline(RuntimeMethodSchemaRefs['agh.integrity'].authorityAbort.input, value),
  }
  const provider = createReferenceIntegrityProvider({
    binding,
    scope,
    authorize: async (_operation, call) => (allowed(call) ? ok() : denied()),
    maintenance: { verifyPackage: async () => denied(), authorityTransfer: port },
  })
  return {
    port,
    provider,
    operation,
    controller,
    original,
    effects: () => effects,
    persisted(owner: OwnerRef) {
      const reopened = new DatabaseSync(path)
      try {
        const row = reopened.prepare('SELECT body FROM requests WHERE id=?').get(owner.id)
        return typeof row?.body === 'string' ? (JSON.parse(row.body) as DataRef) : null
      } finally {
        reopened.close()
      }
    },
    remove(owner: OwnerRef) {
      db.prepare('DELETE FROM requests WHERE id=?').run(owner.id)
    },
    revoke() {
      db.exec('UPDATE permissions SET revoked=1')
    },
    async close() {
      await provider.close('shutdown')
      db.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

describe('reference Integrity real maintenance recovery boundary', () => {
  it.each(['abort', 'late-deny', 'failed-reconcile'] as const)(
    'retains a committed %s result with a real reconciliation owner',
    async (mode) => {
      const f = transferFixture(mode)
      try {
        const result = await present(f.provider.maintenance)(f.operation, context(f.controller.signal))
        if (result.ok || result.error.retryAdvice.kind !== 'reconcile')
          throw new Error('missing actual unknown owner')
        expect(validateRuntimeErrorDetail(result.error).ok).toBe(true)
        expect(result.error.code).toBe('unknown_effect')
        expect(validateRuntimeErrorDetail({ ...result.error, retryAdvice: { kind: 'never' } }).ok).toBe(false)
        const owner = result.error.retryAdvice.ownerRef
        expect(f.persisted(owner)).toEqual(f.original)
        expect(f.effects()).toBe(1)
        const recovered = await f.port.reconcile(f.operation, owner, context())
        if (mode === 'abort') expect(recovered).toEqual({ ok: true, value: f.original })
        if (mode === 'late-deny') expect(recovered.ok).toBe(false)
        expect(
          (await f.port.reconcile(f.operation, { ...owner, id: 'fabricated-owner' }, context())).ok,
        ).toBe(false)
        const changed = {
          ...f.operation,
          input: inline(RuntimeMethodSchemaRefs['agh.integrity'].authorityAbort.input, {
            upgradeId: 'upgrade',
            expectedFenceId: 'other-fence',
            recoveryRoute: inline(RuntimeMethodSchemaRefs['agh.integrity'].canonicalize.input, {
              value: null,
            }),
          }),
        }
        expect((await f.port.reconcile(changed, owner, context())).ok).toBe(false)
        f.remove(owner)
        expect((await f.port.reconcile(f.operation, owner, context())).ok).toBe(false)
        expect(f.effects()).toBe(1)
      } finally {
        await f.close()
      }
    },
  )
  it.each(['normal', 'bad-output', 'throw', 'failed'] as const)(
    'returns the actual original committed result after %s without reexecuting',
    async (mode) => {
      const f = transferFixture(mode)
      try {
        const result = await present(f.provider.maintenance)(f.operation, context())
        expect(result).toEqual({ ok: true, value: f.original })
        expect(f.effects()).toBe(1)
        const again = await present(f.provider.maintenance)(f.operation, context())
        expect(again).toEqual(result)
        expect(f.effects()).toBe(1)
      } finally {
        await f.close()
      }
    },
  )
  it('keeps pending recovery active through drain and returns real unknown on close', async () => {
    const f = transferFixture('failed')
    let entered: () => void = () => undefined
    const pendingRecovery = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.port.reconcile = async (_operation, _owner, call) =>
      new Promise((resolve) => {
        entered()
        call.signal.addEventListener(
          'abort',
          () =>
            resolve({
              ok: false,
              error: {
                code: 'cancelled',
                detailCode: 'cancelled',
                message: 'stopped',
                diagnosticId: 'fixture',
                retryAdvice: { kind: 'never' },
              },
            }),
          { once: true },
        )
      })
    try {
      const pending = present(f.provider.maintenance)(f.operation, context())
      await pendingRecovery
      const drained = await f.provider.drain(new Date().toISOString(), context())
      expect(drained.ok && drained.value.state).toBe('blocked')
      expect(drained.ok && drained.value.activeInvocationIds).toEqual(['call'])
      await f.provider.close('shutdown')
      const result = await pending
      if (result.ok || result.error.retryAdvice.kind !== 'reconcile')
        throw new Error('committed effect lost its recovery owner')
      expect(validateRuntimeErrorDetail(result.error).ok).toBe(true)
      expect(f.persisted(result.error.retryAdvice.ownerRef)).toEqual(f.original)
      expect(f.effects()).toBe(1)
    } finally {
      await f.close()
    }
  })
  it('rejects missing recovery capability, a foreign selected owner, and fake owner shape before effects', async () => {
    const f = transferFixture()
    try {
      for (const port of [
        { ...f.port, reconcile: undefined },
        {
          ...f.port,
          descriptor: { ...f.port.descriptor, binding: { ...binding, bindingId: 'foreign-binding' } },
        },
        { ...f.port, descriptor: { ...f.port.descriptor, methods: ['canonicalize'] } },
      ])
        expect(() =>
          createReferenceIntegrityProvider({
            binding,
            scope,
            authorize: ok,
            maintenance: {
              verifyPackage: async () => ({
                ok: false,
                error: {
                  code: 'denied',
                  detailCode: 'permission_denied',
                  message: 'denied',
                  retryAdvice: { kind: 'never' },
                  diagnosticId: 'test',
                },
              }),
              authorityTransfer: port as unknown as ReferenceIntegrityTransferPort,
            },
          }),
        ).toThrow()
      f.port.prepare = async () => ({
        ok: true,
        value: { kind: 'action', id: 'not-a-durable-request-owner' },
      })
      expect((await present(f.provider.maintenance)(f.operation, context())).ok).toBe(false)
      expect(f.effects()).toBe(0)
    } finally {
      await f.close()
    }
  })
})
