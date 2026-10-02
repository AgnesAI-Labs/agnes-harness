import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RuntimeMethodSchemaRefs, RuntimeServiceCatalog, validateRuntime } from '@agnes/protocol/runtime'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { runtimeSchemaDocument } from '../../src/runtime/schema-document.js'
import { loadRuntimeSchemaGraph } from '../../tools/gen-runtime-full.js'

const digest = 'a'.repeat(64)
const checkpoint = { lastSeq: 0, legacyThroughSeq: 0, headDigest: null }
const event = {
  seq: 1,
  ts: '2026-10-01T00:00:00Z',
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  type: 'turn/start',
  data: {},
  actor: { id: 'actor', org: 'org', role: 'user', deptPath: [], attrs: {} },
  origin: 'principal',
  trust: 'trusted',
}
const row = { sessionKey: 'parent'.repeat(100), event, integrity: null }
const ledger = {
  kind: 'ledger-page',
  algorithm: 'agnes-ledger-jcs-sha256-v1',
  initial: checkpoint,
  rows: [row],
}
const commit = {
  commitId: 'commit',
  transactionFingerprint: digest,
  runId: null,
  actionId: null,
  authorityEpoch: 1,
  writerEpoch: 1,
  previousCommitId: null,
  mutationsDigest: digest,
  mutationCount: 0,
  sideListsDigest: digest,
  counts: { createdActions: 0, consumedSignals: 0, outboxEvents: 0, receipts: 0, usageOrigins: 0 },
}
const manifest = { kind: 'commit-manifest', commit, mutations: [], sideEntries: [] }

describe('integrity compute contracts', () => {
  it('closes canonicalization envelopes and preserves JSON versus unsigned-number semantics', () => {
    expect(validateRuntime('IntegrityCanonicalizeRequest', { value: { number: -0 } }).ok).toBe(true)
    expect(validateRuntime('IntegrityCanonicalizeRequest', { value: null, extra: true }).ok).toBe(false)
    expect(validateRuntime('IntegrityCanonicalizeRequest', {}).ok).toBe(false)
    const result = { canonical: 'null', digest, bytes: 4 }
    expect(validateRuntime('IntegrityCanonicalizeResult', result).ok).toBe(true)
    expect(validateRuntime('IntegrityCanonicalizeResult', { ...result, bytes: -0 }).ok).toBe(false)
    expect(validateRuntime('IntegrityCanonicalizeResult', { ...result, digest: 'invalid' }).ok).toBe(false)
    expect(validateRuntime('IntegrityCanonicalizeResult', { ...result, extra: true }).ok).toBe(false)
  })

  it('bounds page shape at 500 rows without narrowing physical owner strings', () => {
    expect(validateRuntime('IntegrityVerifyRequest', { ...ledger, rows: Array(500).fill(row) }).ok).toBe(true)
    expect(validateRuntime('IntegrityVerifyRequest', { ...ledger, rows: Array(501).fill(row) }).ok).toBe(
      false,
    )
    expect(validateRuntime('IntegrityVerifyRequest', { ...ledger, rows: [] }).ok).toBe(true)
    const child = { ...row, sessionKey: 'child', event: { ...event, seq: 2 } }
    expect(validateRuntime('IntegrityVerifyRequest', { ...ledger, rows: [row, child] }).ok).toBe(true)
    expect(validateRuntime('IntegrityVerifyRequest', { ...ledger, algorithm: 'new-algorithm' }).ok).toBe(
      false,
    )
    expect(validateRuntime('IntegrityVerifyRequest', { ...ledger, sessionKey: 'child' }).ok).toBe(false)
  })

  it('requires the complete existing event envelope and closed ledger wrappers', () => {
    for (const key of ['actor', 'origin', 'trust', 'id', 'ts', 'type', 'data', 'seq']) {
      const incomplete = { ...event }
      delete (incomplete as Record<string, unknown>)[key]
      expect(validateRuntime('LedgerIntegrityRow', { ...row, event: incomplete }).ok).toBe(false)
    }
    expect(validateRuntime('LedgerIntegrityRow', { ...row, extra: true }).ok).toBe(false)
    expect(validateRuntime('LedgerIntegrityRow', { ...row, event: { ...event, seq: 0 } }).ok).toBe(false)
    expect(
      validateRuntime('LedgerIntegrityMetadata', { mode: 'anchor', previousDigest: null, digest }).ok,
    ).toBe(true)
    expect(
      validateRuntime('LedgerIntegrityMetadata', { mode: 'legacy', previousDigest: null, digest }).ok,
    ).toBe(false)
    expect(validateRuntime('LedgerIntegrityCheckpoint', { ...checkpoint, lastSeq: -0 }).ok).toBe(false)
    expect(validateRuntime('LedgerIntegrityCheckpoint', { ...checkpoint, extra: true }).ok).toBe(false)
  })

  it('reuses complete commit, mutation and typed side-entry shapes', () => {
    expect(validateRuntime('IntegrityVerifyRequest', manifest).ok).toBe(true)
    const mutation = { commitId: 'commit', recordId: 'record', previousRevision: null, next: null }
    const side = { commitId: 'commit', kind: 'action-created', actionId: 'action' }
    expect(
      validateRuntime('IntegrityVerifyRequest', { ...manifest, mutations: [mutation], sideEntries: [side] })
        .ok,
    ).toBe(true)
    expect(
      validateRuntime('IntegrityVerifyRequest', { ...manifest, commit: { commitId: 'commit' } }).ok,
    ).toBe(false)
    expect(
      validateRuntime('IntegrityVerifyRequest', { ...manifest, mutations: [{ ...mutation, extra: true }] })
        .ok,
    ).toBe(false)
    expect(
      validateRuntime('IntegrityVerifyRequest', {
        ...manifest,
        sideEntries: [{ ...side, signalId: 'signal' }],
      }).ok,
    ).toBe(false)
    expect(validateRuntime('IntegrityVerifyRequest', { ...manifest, rows: [] }).ok).toBe(false)
    expect(
      validateRuntime('IntegrityVerifyRequest', { ...manifest, mutations: Array(10001).fill(mutation) }).ok,
    ).toBe(false)
  })

  it('separates closed response branches', () => {
    expect(validateRuntime('IntegrityVerifyResult', { kind: 'ledger-page', checkpoint }).ok).toBe(true)
    expect(
      validateRuntime('IntegrityVerifyResult', {
        kind: 'commit-manifest',
        commitId: 'commit',
        mutationsDigest: digest,
        sideListsDigest: digest,
      }).ok,
    ).toBe(true)
    expect(
      validateRuntime('IntegrityVerifyResult', { kind: 'ledger-page', checkpoint, commitId: 'commit' }).ok,
    ).toBe(false)
    expect(validateRuntime('IntegrityVerifyResult', { kind: 'commit-manifest', commitId: 'commit' }).ok).toBe(
      false,
    )
  })

  it('adds non-broker compute identities and records the current package verification revisions', () => {
    const catalog = RuntimeServiceCatalog['agh.integrity'].methods
    for (const method of ['canonicalize', 'verify'] as const) {
      expect(catalog[method].kind).toBe('compute')
      expect(catalog[method].sameAttemptBrokerAllowed).toBe(false)
      const refs = RuntimeMethodSchemaRefs['agh.integrity'][method]
      expect(refs.input.typeId).toBe(`agh.integrity/${method}.request@1`)
      expect(refs.output.typeId).toBe(`agh.integrity/${method}.response@1`)
      expect(refs.input.digest).not.toBe(refs.output.digest)
    }
    expect(catalog.verifyPackage.kind).toBe('maintenance')
    expect(RuntimeMethodSchemaRefs['agh.integrity'].verifyPackage).toEqual({
      input: {
        typeId: 'agh.integrity/verifyPackage.request@1',
        revision: 2,
        digest: 'cc59884e6574b5785a248c6dd58871da99407ea38243ea3c084edf322f8aa17e',
      },
      output: {
        typeId: 'agh.integrity/verifyPackage.response@1',
        revision: 2,
        digest: '332c87c5349f8eed9906f9667e08b50922d021369dd071d92087c5d7dce74649',
      },
    })
  })

  it('preserves authority references and agrees with the independent JSON Schema validator', () => {
    const directory = fileURLToPath(new URL('../../schema/runtime', import.meta.url))
    const source = JSON.parse(readFileSync(`${directory}/public.json`, 'utf8'))
    expect(source.$defs.LedgerIntegrityRow.properties.event.$ref).toBe(
      'https://agnes.ai/schema/session-v1.json#/$defs/EventEnvelope',
    )
    const { document } = loadRuntimeSchemaGraph(directory)
    expect(document.$defs).toHaveProperty('IntegrityCanonicalizeRequest')
    const ajv = new Ajv2020({ strict: false, validateFormats: false })
    const vectors = {
      IntegrityCanonicalizeRequest: [{ value: null }, { value: [1, 'x'] }, {}, { value: null, extra: true }],
      IntegrityCanonicalizeResult: [
        { canonical: 'null', digest, bytes: 4 },
        { canonical: '', digest: 'bad', bytes: 0 },
      ],
      LedgerIntegrityCheckpoint: [checkpoint, { ...checkpoint, lastSeq: -1 }],
      LedgerIntegrityMetadata: [
        { mode: 'chain', previousDigest: digest, digest },
        { mode: 'wrong', previousDigest: null, digest },
      ],
      LedgerIntegrityRow: [row, { ...row, event: { seq: 1, data: {} } }],
      IntegrityVerifyRequest: [
        ledger,
        manifest,
        { ...ledger, rows: Array(501).fill(row) },
        { ...manifest, rows: [] },
      ],
      IntegrityVerifyResult: [
        { kind: 'ledger-page', checkpoint },
        { kind: 'ledger-page', checkpoint, extra: true },
      ],
    }
    for (const [name, values] of Object.entries(vectors)) {
      const oracle = ajv.compile(runtimeSchemaDocument(document, name))
      for (const value of values)
        expect(validateRuntime(name as keyof typeof vectors, value).ok).toBe(oracle(value))
    }
  })
})
