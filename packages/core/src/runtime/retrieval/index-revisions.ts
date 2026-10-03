import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { MemoryFault } from '../memory/access.js'

/** Internal index ingestion data; deliberately not an Embedding result or vectorsRef schema. */
export interface IndexDocument {
  memoryId: string
  text: string
  vector: readonly number[]
  createdAt: string
}
export interface IndexBatch {
  expectedRevision: number
  dimensions: number
  documents: readonly IndexDocument[]
  queryVectors: Readonly<Record<string, readonly number[]>>
}
export const terms = (text: string): string[] => [
  ...new Set(
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  ),
]
export function validateIndexBatch(batch: IndexBatch): void {
  if (
    !Number.isSafeInteger(batch.dimensions) ||
    batch.dimensions < 1 ||
    batch.dimensions > 8192 ||
    !Number.isSafeInteger(batch.expectedRevision) ||
    batch.expectedRevision < 0 ||
    batch.documents.length > 10_000 ||
    new Set(batch.documents.map((doc) => doc.memoryId)).size !== batch.documents.length
  )
    throw new MemoryFault('invalid_input', 'retrieval_index_invalid')
  for (const vector of [...batch.documents.map((doc) => doc.vector), ...Object.values(batch.queryVectors)]) {
    if (vector.length !== batch.dimensions || vector.some((value) => !Number.isFinite(value)))
      throw new MemoryFault('invalid_input', 'retrieval_dimension_mismatch')
  }
  for (const doc of batch.documents)
    if (!doc.memoryId || typeof doc.text !== 'string' || !Number.isFinite(Date.parse(doc.createdAt)))
      throw new MemoryFault('invalid_input', 'retrieval_document_invalid')
}
export function hybridScore(
  query: string,
  text: string,
  vector: readonly number[],
  queryVector?: readonly number[],
): number {
  const sought = terms(query),
    content = new Set(terms(text))
  const lexical = sought.length ? sought.filter((term) => content.has(term)).length / sought.length : 0
  let similarity = 0
  if (queryVector) {
    const normalize = (values: readonly number[]) => {
      const scale = Math.max(...values.map(Math.abs))
      if (!scale) return values.map(() => 0)
      const scaled = values.map((value) => value / scale),
        norm = Math.hypot(...scaled)
      return scaled.map((value) => value / norm)
    }
    const a = normalize(vector),
      b = normalize(queryVector)
    similarity = Math.min(
      1,
      Math.max(
        0,
        a.reduce((sum, value, i) => sum + value * b[i]!, 0),
      ),
    )
  }
  return (lexical + similarity) / 2
}
export function deletionFingerprint(receipt: Wire.DeletionReceipt): string {
  if (
    !validateRuntime('DeletionReceipt', receipt).ok ||
    receipt.authorityId !== 'memory' ||
    receipt.invalidatedRefs.some(
      (ref) =>
        ref.kind !== 'domain' ||
        ref.value.typeId !== 'agh.memory/item@1' ||
        ref.value.authorityId !== 'memory',
    )
  )
    throw new MemoryFault('invalid_input', 'retrieval_deletion_invalid')
  return canonicalJsonDigest(receipt)
}
