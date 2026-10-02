import type { RecordVersionRef } from '@agnes/protocol/runtime'
import { RuntimeSchemaRefs } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { assertStateLeasePredecessor, assertStateProofVersion } from '../src/runtime/state/proof-versions.js'

const schema = RuntimeSchemaRefs.RuntimeFormatData
const version = (revision = 1): RecordVersionRef => ({
  recordId: 'record',
  recordRevision: revision,
  schema,
  commitId: 'commit',
  digest: 'a'.repeat(64),
  body: {
    state: 'available',
    ref: { kind: 'inline', schema, value: null, digest: 'b'.repeat(64), bytes: 4 },
  },
})
const guard = { recordId: 'record', expectedRecordRevision: 1 }

describe('State historical proof source relationships', () => {
  it('accepts an exact available original source version', () => {
    expect(() => assertStateProofVersion(guard, version(), schema, 'commit')).not.toThrow()
  })
  it.each([null, 0, -0, -1, 1.5])('rejects an unproven guard revision %s', (expectedRecordRevision) => {
    expect(() => assertStateProofVersion({ ...guard, expectedRecordRevision }, version(), schema)).toThrow()
  })
  it('rejects another record even if its revision and schema are identical', () => {
    expect(() => assertStateProofVersion(guard, { ...version(), recordId: 'other' }, schema)).toThrow('guard')
  })
  it('rejects a source created in a different transaction', () => {
    expect(() => assertStateProofVersion(guard, version(), schema, 'later')).toThrow('original transaction')
  })
  it('does not let a same typeId and revision hide an unknown digest', () => {
    expect(() => assertStateProofVersion(guard, version(), { ...schema, digest: '0'.repeat(64) })).toThrow(
      'schema mismatch',
    )
  })
  it('requires retained source bytes even when an index still names the original version', () => {
    expect(() =>
      assertStateProofVersion(
        guard,
        { ...version(), body: { state: 'pruned', pruneId: 'prune', proofCommitId: 'prune-commit' } },
        schema,
      ),
    ).toThrow('unavailable')
  })
  it('accepts a verified first lease version with no predecessor', () => {
    expect(() => assertStateLeasePredecessor(version(), null)).not.toThrow()
  })
  it('does not interpret missing prior versions as genesis', () => {
    expect(() => assertStateLeasePredecessor(version(2), null)).toThrow('genesis')
  })
  it('requires a consecutive predecessor of the same record and exact schema', () => {
    expect(() => assertStateLeasePredecessor(version(2), version())).not.toThrow()
    expect(() => assertStateLeasePredecessor(version(3), version())).toThrow('predecessor')
    expect(() => assertStateLeasePredecessor(version(2), { ...version(), recordId: 'other' })).toThrow(
      'predecessor',
    )
    expect(() =>
      assertStateLeasePredecessor(version(2), {
        ...version(),
        schema: { ...schema, digest: '0'.repeat(64) },
      }),
    ).toThrow('predecessor')
  })
})
