import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  RuntimeStateLegacyReaders,
  RuntimeStateOpenRetryPolicy,
  RuntimeStateQueryMethods,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { loadRuntimeSchemaGraph } from '../../tools/gen-runtime-full.js'
import { validateStateOpenDefinition, validateStateRuntimeMetadata } from '../../tools/gen-runtime-state.js'

const directory = fileURLToPath(new URL('../../schema/runtime/', import.meta.url))
const read = (name: string) => JSON.parse(readFileSync(`${directory}${name}.json`, 'utf8'))
const graph = loadRuntimeSchemaGraph(directory).document
const metadata = read('public')
const local = read('local-api')
const documents = read('state85-legacy-schema-documents')
const digest = 'a'.repeat(64)
const authority = { authorityId: 'authority', tenantId: 'tenant', authorityEpoch: 1 }
const guard = { recordId: 'record', expectedRecordRevision: 1 }
const write = {
  requestId: 'open',
  authority,
  sessionId: 'session',
  mode: 'write',
  writerId: 'writer',
  ttlMs: 1000,
}
const proof = {
  request: write,
  requestFingerprint: digest,
  evaluatedAt: '2026-10-02T00:00:00Z',
  sessionIdentityVersion: guard,
  previousLeaseVersion: null,
  leaseVersion: guard,
  snapshotId: 'snapshot',
  snapshotExpiresAt: '2026-10-02T00:00:01Z',
  snapshotCommitId: 'commit',
}

describe('State protocol source and historical reader metadata', () => {
  it('accepts both reader stages and refuses future readers without changing format major', () => {
    const format = {
      formatVersion: 2,
      runtimeSchemaMajor: 1,
      minReader: 1,
      previousFormat: 1,
      legacyThroughSeq: 0,
      sourceHeadDigest: null,
    }
    for (const minReader of [1, 2])
      expect(validateRuntime('RuntimeFormatData', { ...format, minReader }).ok).toBe(true)
    for (const minReader of [0, -0, 3, 1.5, '2'])
      expect(validateRuntime('RuntimeFormatData', { ...format, minReader }).ok).toBe(false)
    expect(validateRuntime('RuntimeFormatData', { ...format, formatVersion: 3 }).ok).toBe(false)
  })

  it('reuses the exact write-open branch and closes all proof fields', () => {
    expect(validateRuntime('StateWriteOpenProofValue', proof).ok).toBe(true)
    expect(
      validateRuntime('StateWriteOpenProofValue', {
        ...proof,
        request: { ...write, mode: 'read', writerId: null, ttlMs: null },
      }).ok,
    ).toBe(false)
    expect(validateRuntime('StateWriteOpenProofValue', { ...proof, minReader: 2 }).ok).toBe(false)
    for (const field of Object.keys(proof)) {
      const incomplete: Record<string, unknown> = { ...proof }
      delete incomplete[field]
      expect(validateRuntime('StateWriteOpenProofValue', incomplete).ok, field).toBe(false)
    }
    expect(
      validateRuntime('StateLeaseRecordValue', { sessionId: 'session', lastWriterEpoch: 1, claim: null }).ok,
    ).toBe(true)
    expect(
      validateRuntime('StateLeaseRecordValue', { sessionId: 'session', lastWriterEpoch: -0, claim: null }).ok,
    ).toBe(false)
    const lease = {
      requestId: 'lease',
      authority,
      sessionId: 'session',
      writerId: 'writer',
      operation: 'acquire',
      expectedWriterEpoch: null,
      expectedLastSeq: 0,
      ttlMs: 1000,
    }
    const { snapshotId: _id, snapshotExpiresAt: _until, snapshotCommitId: _commit, ...base } = proof
    expect(validateRuntime('StateLeaseProofValue', { ...base, request: lease }).ok).toBe(true)
    expect(
      validateRuntime('StateLeaseProofValue', { ...base, request: lease, snapshotId: 'snapshot' }).ok,
    ).toBe(false)
  })

  it('publishes only Q method IDs, the bounded page shape and nullable commit probe', () => {
    expect(RuntimeStateQueryMethods).toEqual(['scan', 'probeCommit'])
    const method = RuntimeMethodSchemaRefs['agh.state']
    expect(method.scan.input.typeId).toBe('agh.state/scan.request@1')
    expect(method.scan.output.typeId).toBe('agh.state/scan.response@1')
    expect(method.probeCommit.input.typeId).toBe('agh.state/probeCommit.request@1')
    expect(method.probeCommit.output.typeId).toBe('agh.state/probeCommit.response@1')
    const item = {
      kind: 'inline',
      schema: RuntimeSchemaRefs.StateLeaseRecordValue,
      value: null,
      digest,
      bytes: 4,
    }
    const page = { items: Array(500).fill(item), snapshot: 'snapshot', nextCursor: null, complete: true }
    expect(validateRuntime('StateScanResult', page).ok).toBe(true)
    expect(validateRuntime('StateScanResult', { ...page, items: Array(501).fill(item) }).ok).toBe(false)
    expect(validateRuntime('StateScanResult', { ...page, cursor: null }).ok).toBe(false)
    expect(validateRuntime('StateProbeCommitRequest', { commitId: 'commit' }).ok).toBe(true)
    expect(validateRuntime('StateProbeCommitRequest', { commitId: 'commit', requestId: 'request' }).ok).toBe(
      false,
    )
    expect(validateRuntime('StateProbeCommitResult', null).ok).toBe(true)
    expect(validateRuntime('StateProbeCommitResult', {}).ok).toBe(false)
  })

  it('emits a frozen source table with exact historical identities and current target revisions', () => {
    expect(() => validateStateRuntimeMetadata(graph, metadata, local, documents)).not.toThrow()
    expect(RuntimeStateLegacyReaders.entries).toHaveLength(17)
    expect(RuntimeStateOpenRetryPolicy.byMode).toEqual({
      read: 'fresh-verified-snapshot',
      write: 'immutable-original-result',
    })
    for (const entry of RuntimeStateLegacyReaders.entries) {
      expect(Object.isFrozen(entry)).toBe(true)
      expect(Object.isFrozen(entry.source)).toBe(true)
      expect(RuntimeSchemaRefs[entry.targetDefinition].revision).toBe(entry.targetRevision)
      expect(RuntimeSchemaRefs[entry.targetDefinition].typeId).toBe(entry.source.typeId)
    }
    expect(
      RuntimeStateLegacyReaders.entries.find((e) => e.targetDefinition === 'OutboxRecord')?.targetRevision,
    ).toBe(3)
  })

  it.each([
    'digest',
    'revision',
    'profile',
    'target',
    'rule',
    'duplicate',
    'extra',
    'reader',
    'query',
    'broker',
    'open',
    'local',
  ])('rejects malformed source metadata: %s', (mutation) => {
    const m = structuredClone(metadata),
      l = structuredClone(local)
    const table = m['x-state-legacy-readers'],
      entry = table.entries[0]
    if (mutation === 'digest') entry.source.digest = '0'.repeat(64)
    if (mutation === 'revision') entry.targetRevision += 1
    if (mutation === 'profile') entry.decoderProfile = 'state85-outbox-delivery'
    if (mutation === 'target') entry.targetDefinition = 'NoSuchDefinition'
    if (mutation === 'rule') entry.conversionRule = 'O'
    if (mutation === 'duplicate') table.entries[1] = structuredClone(entry)
    if (mutation === 'extra') entry.source.owner = 'untrusted'
    if (mutation === 'reader') table.targetMinReader = 3
    if (mutation === 'query') m['x-state-query-api'].methods.push('lease')
    if (mutation === 'broker')
      m['x-service-catalog']['agh.state'].methods.scan.sameAttemptBrokerAllowed = true
    if (mutation === 'open') m['x-state-open-retry-policy'].byMode.read = 'immutable-original-result'
    if (mutation === 'local') l['x-local-api'].runtime.StateStoreControl += '\nscan(request: unknown): void'
    expect(() => validateStateRuntimeMetadata(graph, m, l, documents)).toThrow()
  })

  it('refuses drift of the controlled write fragment before generation', () => {
    const open = read('prototype').$defs.StateOpenRequest
    expect(() => validateStateOpenDefinition(open)).not.toThrow()
    const changed = structuredClone(open)
    changed.anyOf.reverse()
    expect(() => validateStateOpenDefinition(changed)).toThrow()
    const weakened = structuredClone(open)
    weakened.anyOf[1].required.pop()
    expect(() => validateStateOpenDefinition(weakened)).toThrow()
    const extended = structuredClone(open)
    extended.anyOf[1].properties.extra = { type: 'string' }
    expect(() => validateStateOpenDefinition(extended)).toThrow()
  })
})
