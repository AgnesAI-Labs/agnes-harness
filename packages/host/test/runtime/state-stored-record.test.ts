import { canonicalJsonDigest, RuntimeSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  bodyItem,
  ITEM_MAX_BYTES,
  PAGE_MAX_BYTES,
  type ProvenFact,
  STORED_SCHEMA_PENDING,
  storedItem,
  storedOf,
} from '../../src/runtime/state/stored-record.js'

const owner = {
  authority: { authorityId: 'state', tenantId: 'tenant', authorityEpoch: 1 },
  scope: { kind: 'runtime' as const, installationId: 'i', runtimeId: 'r' },
  ownerBinding: { bindingId: 'b', contract: 'agh.state', logicalName: 'state', providerId: 'p' },
}
const fact = (over: Partial<ProvenFact> = {}): ProvenFact => ({
  recordId: 'run:r',
  recordRevision: 3,
  schema: RuntimeSchemaRefs.RunRecordValue,
  owner,
  value: { a: 1 },
  digest: 'd'.repeat(64),
  commitId: 'commit-3',
  ledgerSeq: 9,
  minReader: 2,
  createdAt: '2026-10-05T00:00:00Z',
  updatedAt: '2026-10-05T00:05:00Z',
  ...over,
})

describe('Stored envelope', () => {
  it('maps the proven fact to RecordMeta without borrowing from anywhere else', () => {
    const stored = storedOf(fact())
    expect(stored.meta).toEqual({
      recordId: 'run:r',
      schema: RuntimeSchemaRefs.RunRecordValue,
      minReader: 2,
      recordRevision: 3,
      lastCommitId: 'commit-3',
      createdAt: '2026-10-05T00:00:00Z',
      updatedAt: '2026-10-05T00:05:00Z',
    })
    expect(stored.owner).toEqual(owner)
    expect(Object.keys(stored).sort()).toEqual(['meta', 'owner', 'value'])
    // The envelope schema is not registered in the public protocol yet, so there is no
    // validateRuntime('StoredRecord') assertion here; the shape is asserted structurally.
    expect(validateRuntime('RecordMeta', stored.meta).ok).toBe(true)
    expect(validateRuntime('RecordOwner', stored.owner).ok).toBe(true)
  })
  it('wraps the record in an inline DataRef whose schema is the envelope, never the body schema', () => {
    const item = storedItem(fact())
    expect(item.schema).toEqual(STORED_SCHEMA_PENDING)
    expect(item.schema).not.toEqual(RuntimeSchemaRefs.RunRecordValue)
    expect(item.digest).toBe(canonicalJsonDigest(item.value))
    expect(item.bytes).toBe(Buffer.byteLength(JSON.stringify(item.value), 'utf8'))
    expect(storedItem(fact())).toEqual(item)
  })
  it('emits a body-only DataRef for actions and signals', () => {
    const item = bodyItem(fact())
    expect(item.schema).toEqual(RuntimeSchemaRefs.RunRecordValue)
    expect(item.value).toEqual({ a: 1 })
    expect(item.digest).toBe(canonicalJsonDigest({ a: 1 }))
  })
  it('refuses an item above the item cap instead of truncating it', () => {
    const big = fact({ value: { text: 'x'.repeat(ITEM_MAX_BYTES) } })
    expect(() => storedItem(big)).toThrowError(
      expect.objectContaining({ failure: expect.objectContaining({ detailCode: 'state_item_oversize' }) }),
    )
    expect(PAGE_MAX_BYTES).toBeGreaterThan(ITEM_MAX_BYTES)
  })
  it('refuses a fact whose meta cannot be proven rather than defaulting it', () => {
    const unproven = expect.objectContaining({
      failure: expect.objectContaining({ detailCode: 'state_meta_unproven' }),
    })
    expect(() => storedOf(fact({ createdAt: '' }))).toThrowError(unproven)
    expect(() => storedOf(fact({ minReader: 0 }))).toThrowError(unproven)
    expect(() => storedOf(fact({ updatedAt: '2026-10-05T00:05:00' }))).toThrowError(unproven)
  })
})
