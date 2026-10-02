import { strict as assert } from 'node:assert'
import { jcs } from '@agnes/protocol'
import {
  canonicalJsonDigest,
  type DataRef,
  type IntegrityVerifyRequest,
  type LedgerIntegrityRow,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  type RuntimeWireTypes,
  type SchemaRef,
  validateRuntime,
  validateRuntimeErrorDetail,
} from '@agnes/protocol/runtime'
import type { CallContext, ServiceProvider } from '../../../src/runtime/index.js'

/** A real selected provider and a currently authorized Host call; the suite grants nothing. */
export interface IntegrityContractBinding {
  readonly provider: ServiceProvider
  readonly context: () => CallContext
  readonly target: RuntimeWireTypes['BindingRef']
}
const refs = RuntimeMethodSchemaRefs['agh.integrity']
const catalog = RuntimeServiceCatalog['agh.integrity'].methods
const inline = (schema: SchemaRef, value: unknown): DataRef => {
  const json = structuredClone(value) as RuntimeWireTypes['JsonValue']
  return {
    kind: 'inline',
    schema,
    value: json,
    digest: canonicalJsonDigest(json),
    bytes: Buffer.byteLength(jcs(value)),
  }
}

/** Runs actual public ServiceOperation requests, checking both refusal and complete output codecs. */
export async function runIntegrityContract(binding: IntegrityContractBinding): Promise<readonly string[]> {
  const evidence: string[] = []
  async function invoke(
    method: 'canonicalize' | 'verify',
    value: unknown,
    accepted: boolean,
  ): Promise<unknown> {
    assert(binding.provider.compute, 'selected Integrity provider has no compute handler')
    const result = await binding.provider.compute(
      { target: binding.target, method, input: inline(refs[method].input, value) },
      binding.context(),
    )
    assert.equal(result.ok, accepted, `${method} acceptance differs from the contract`)
    if (!result.ok) {
      assert(validateRuntimeErrorDetail(result.error).ok, 'refusal must use a formal classified RuntimeError')
      evidence.push(`${method}:refused`)
      return null
    }
    assert.equal(result.value.kind, 'inline')
    if (result.value.kind !== 'inline') throw new Error('non-inline compute result')
    assert.deepEqual(result.value.schema, refs[method].output)
    assert.equal(result.value.digest, canonicalJsonDigest(result.value.value))
    assert.equal(result.value.bytes, Buffer.byteLength(jcs(result.value.value)))
    const decoded = validateRuntime(catalog[method].output, result.value.value)
    assert(decoded.ok, 'output must satisfy the exact official method codec')
    evidence.push(`${method}:accepted`)
    return JSON.parse(jcs(decoded.value)) as unknown
  }
  const canonical = await invoke('canonicalize', { value: { z: '😀', a: -0 } }, true)
  assert.deepEqual(canonical, {
    canonical: '{"a":0,"z":"😀"}',
    digest: canonicalJsonDigest({ a: 0, z: '😀' }),
    bytes: Buffer.byteLength('{"a":0,"z":"😀"}'),
  })
  await invoke('canonicalize', { value: null, extra: true }, false)
  await invoke('canonicalize', {}, false)
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
  const initial = { lastSeq: 0, legacyThroughSeq: 0, headDigest: null }
  const legacy: LedgerIntegrityRow = { sessionKey: 'parent', event: event(1), integrity: null }
  const anchoredEvent = event(2)
  const anchorHash = canonicalJsonDigest({
    algorithm: 'agnes-ledger-jcs-sha256-v1',
    sessionKey: 'parent',
    legacyThroughSeq: 1,
    event: anchoredEvent,
  })
  const anchor: LedgerIntegrityRow = {
    sessionKey: 'parent',
    event: anchoredEvent,
    integrity: { mode: 'anchor', previousDigest: null, digest: anchorHash },
  }
  const chainedEvent = event(3)
  const chainHash = canonicalJsonDigest({
    algorithm: 'agnes-ledger-jcs-sha256-v1',
    sessionKey: 'child',
    previousDigest: anchorHash,
    event: chainedEvent,
  })
  const chain: LedgerIntegrityRow = {
    sessionKey: 'child',
    event: chainedEvent,
    integrity: { mode: 'chain', previousDigest: anchorHash, digest: chainHash },
  }
  const page = (rows: LedgerIntegrityRow[]): IntegrityVerifyRequest => ({
    kind: 'ledger-page',
    algorithm: 'agnes-ledger-jcs-sha256-v1',
    initial,
    rows,
  })
  assert.deepEqual(await invoke('verify', page([legacy, anchor, chain]), true), {
    kind: 'ledger-page',
    checkpoint: { lastSeq: 3, legacyThroughSeq: 1, headDigest: chainHash },
  })
  for (const rows of [
    [chain],
    [legacy, legacy],
    [legacy, { ...anchor, sessionKey: 'changed' }],
    [legacy, anchor, { ...chain, integrity: null }],
    [
      legacy,
      anchor,
      { ...chain, integrity: { mode: 'anchor' as const, previousDigest: null, digest: chainHash } },
    ],
  ])
    await invoke('verify', page(rows), false)
  await invoke(
    'verify',
    { ...page([]), initial: { lastSeq: 2, legacyThroughSeq: 1, headDigest: null } },
    false,
  )
  await invoke('verify', { ...page([]), initial: { ...initial, lastSeq: -0 } }, false)
  const emptyHash = canonicalJsonDigest([])
  const commit = {
    commitId: 'commit',
    transactionFingerprint: 'a'.repeat(64),
    runId: null,
    actionId: null,
    authorityEpoch: 1,
    writerEpoch: 1,
    previousCommitId: null,
    mutationsDigest: emptyHash,
    sideListsDigest: emptyHash,
    mutationCount: 0,
    counts: { createdActions: 0, consumedSignals: 0, outboxEvents: 0, receipts: 0, usageOrigins: 0 },
  }
  const manifest: IntegrityVerifyRequest = { kind: 'commit-manifest', commit, mutations: [], sideEntries: [] }
  assert.deepEqual(await invoke('verify', manifest, true), {
    kind: 'commit-manifest',
    commitId: 'commit',
    mutationsDigest: emptyHash,
    sideListsDigest: emptyHash,
  })
  await invoke('verify', { ...manifest, commit: { ...commit, mutationCount: 1 } }, false)
  await invoke('verify', { ...manifest, commit: { ...commit, sideListsDigest: '0'.repeat(64) } }, false)
  const side = { commitId: 'commit', kind: 'action-created', actionId: 'action' } as const
  const { commitId: _commit, ...sideBody } = side
  const sideHash = canonicalJsonDigest([sideBody])
  await invoke(
    'verify',
    {
      ...manifest,
      sideEntries: [side],
      commit: { ...commit, sideListsDigest: sideHash, counts: { ...commit.counts, createdActions: 1 } },
    },
    true,
  )
  await invoke(
    'verify',
    {
      ...manifest,
      sideEntries: [side, side],
      commit: {
        ...commit,
        sideListsDigest: canonicalJsonDigest([sideBody, sideBody]),
        counts: { ...commit.counts, createdActions: 2 },
      },
    },
    false,
  )
  return Object.freeze(evidence)
}
