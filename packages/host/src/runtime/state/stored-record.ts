import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type JsonValue,
  type RecordMeta,
  type RecordOwner,
  type SchemaRef,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { refuse } from './refusal.js'
import type { NativeStateRecordFact } from './transactions.js'

export const ITEM_MAX_BYTES = 196_608
export const PAGE_MAX_BYTES = 262_144
const LIMITS = { maxBytes: 1_048_576, maxDepth: 64, maxMembers: 10_000 }
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

/**
 * Placeholder for the envelope schema reference. The envelope schema is not registered in the
 * public protocol yet, so this digest is not a real schema digest and an item built with it must
 * not be published. Replace it with the registered reference once the schema exists.
 */
export const STORED_SCHEMA_PENDING: SchemaRef = Object.freeze({
  typeId: 'agh.state/stored-record@1',
  revision: 1,
  digest: '0'.repeat(64),
})

export type Stored = Readonly<{ meta: RecordMeta; owner: RecordOwner; value: JsonValue }>
type Inline = Extract<DataRef, { kind: 'inline' }>

function unproven(): never {
  refuse('incompatible', 'state_meta_unproven', 'a record version has no proven historical meta')
}

/** The only constructor of a Stored envelope. Every meta member is a field of the proven fact. */
export function storedOf(fact: NativeStateRecordFact): Stored {
  const owner = validateRuntime('RecordOwner', fact.owner)
  if (
    !owner.ok ||
    !TIMESTAMP.test(fact.createdAt) ||
    !TIMESTAMP.test(fact.updatedAt) ||
    (fact.minReader !== 1 && fact.minReader !== 2) ||
    !Number.isSafeInteger(fact.recordRevision) ||
    fact.recordRevision < 1 ||
    !fact.commitId
  )
    unproven()
  return Object.freeze({
    meta: Object.freeze({
      recordId: fact.recordId,
      schema: fact.schema,
      minReader: fact.minReader,
      recordRevision: fact.recordRevision,
      lastCommitId: fact.commitId,
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt,
    }),
    owner: owner.value,
    value: fact.value,
  })
}

function inline(schema: SchemaRef, value: unknown): Inline {
  const body = boundedCanonicalJson(value, LIMITS)
  if (!body.ok || body.value.bytes > ITEM_MAX_BYTES)
    refuse('incompatible', 'state_item_oversize', 'a record exceeds the inline item limit')
  return Object.freeze({
    kind: 'inline' as const,
    schema,
    value: body.value.json,
    digest: canonicalJsonDigest(body.value.json),
    bytes: body.value.bytes,
  })
}

export function storedItem(fact: NativeStateRecordFact): Inline {
  return inline(STORED_SCHEMA_PENDING, storedOf(fact))
}

/** Actions and signals travel as their own body schema, without an envelope. */
export function bodyItem(fact: NativeStateRecordFact): Inline {
  return inline(fact.schema, fact.value)
}
