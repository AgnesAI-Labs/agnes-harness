import type { IndexDocument } from './index-revisions.js'

/** Persistence and keyword candidates only; tokenization, authorization and scoring stay in Core.
 * Atomic callbacks are synchronous and roll back on exceptions. Removal receipts, documents
 * and revisions must commit together. Scope ownership is immutable across reopen.
 */
export interface RetrievalStorage {
  assertOwner(scopeDigest: string): void
  transaction<T>(work: () => T): T
  revision(): number
  documents(): readonly IndexDocument[]
  queryVectors(): Readonly<Record<string, readonly number[]>>
  keywordCandidates(terms: readonly string[]): readonly string[]
  replace(
    documents: readonly (IndexDocument & { keywordTerms: readonly string[] })[],
    dimensions: number,
    queryVectors: Readonly<Record<string, readonly number[]>>,
    revision: number,
  ): void
  removal(id: string): { fingerprint: string } | null
  removeDocuments(ids: readonly string[]): void
  putRemoval(id: string, fingerprint: string, watermark: number, revision: number): void
  deletionWatermark(): number
  close(): void
}
