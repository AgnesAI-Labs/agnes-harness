import type { SchemaRef } from '@agnes/protocol/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'
import { integrity, refuse } from './refusal.js'

export type StateRecordDecoder<T> = {
  readonly schema: SchemaRef
  readonly minReader: 1 | 2
  readonly decode: (value: unknown) => T
}

/** Decoder registration identifies exact bytes; it does not authenticate their owner or lineage. */
export function createStateRecordReader<T>(
  supportedReader: 1 | 2,
  registrations: readonly StateRecordDecoder<T>[],
) {
  assertStateReader(supportedReader, 2)
  const decoders = new Map<string, StateRecordDecoder<T>>()
  for (const entry of registrations) {
    const parsed = validateRuntime('SchemaRef', entry.schema)
    if (!parsed.ok || !Number.isSafeInteger(entry.schema.revision) || entry.schema.revision < 1)
      integrity('invalid registered State record schema')
    assertStateReader(entry.minReader, 2)
    const key = schemaKey(entry.schema)
    if (decoders.has(key)) integrity('duplicate State record decoder')
    // Copy registration so a caller cannot redirect an installed decoder by mutating a ref.
    decoders.set(key, { schema: { ...entry.schema }, minReader: entry.minReader, decode: entry.decode })
  }
  return Object.freeze({
    decode(schema: SchemaRef, declaredReader: number, value: unknown): T {
      assertStateReader(declaredReader, supportedReader)
      const parsed = validateRuntime('SchemaRef', schema)
      if (!parsed.ok) integrity('invalid State record schema reference')
      const decoder = decoders.get(schemaKey(schema))
      if (!decoder) refuse('incompatible', 'unknown_schema', 'unknown State record schema reference')
      if (declaredReader < decoder.minReader) integrity('State record understates its minimum reader')
      assertStateReader(decoder.minReader, supportedReader)
      return decoder.decode(value)
    },
  })
}

/** Run before payload decoding, reducer work, or writer acquisition. No format upgrade is performed. */
export function assertStateReader(requiredReader: number, supportedReader: 1 | 2): void {
  if (
    (supportedReader !== 1 && supportedReader !== 2) ||
    !Number.isSafeInteger(requiredReader) ||
    Object.is(requiredReader, -0) ||
    requiredReader < 1 ||
    requiredReader > 2 ||
    requiredReader > supportedReader
  )
    refuse('incompatible', 'unknown_reader', 'unsupported State minimum reader')
}

function schemaKey(schema: SchemaRef): string {
  return JSON.stringify([schema.typeId, schema.revision, schema.digest])
}
