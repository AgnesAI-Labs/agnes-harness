import type { ReferenceSearchResult, ReferenceSelection } from '@agnes/protocol'
import type { ProviderIdentity } from './provider-kind.js'

export type { ReferenceCandidate, ReferenceSearchResult, ReferenceSelection } from '@agnes/protocol'
export interface ReferenceLimits {
  /** UTF-8 excerpt bytes, before JSON fencing; default 32 KiB. */
  maxBytes: number
  /** Entire file hashing/read budget; larger sources are refused. Default 16 MiB. */
  maxSourceBytes: number
  /** Fraction of excerpt bytes reserved for the head; remainder keeps the tail. */
  headFraction: number
}
/** Backend-created ports: implementations must recheck current read permission on every operation. */
export interface ReferenceContext {
  readonly reader: {
    readonly principalId: string
    readonly sessionId: string
    readonly workspaceRoot: string
  }
  readonly signal: AbortSignal
  readonly limits: ReferenceLimits
  readonly files: {
    search(query: string): Promise<ReferenceSearchResult>
    read(path: string): Promise<ResolvedReference>
  }
  readonly sessions: {
    search(query: string): Promise<ReferenceSearchResult>
    read(id: string): Promise<ResolvedReference>
  }
}
export interface ResolvedReference {
  label: string
  text: string
  /** SHA-256 of the complete source version, before excerpt truncation. */
  hash: string
  truncated: boolean
}
/** Plugins supply locators and data; they cannot select message role or context authority. */
export interface ReferenceResolver extends ProviderIdentity {
  search(query: string, context: ReferenceContext): Promise<ReferenceSearchResult>
  resolve(id: string, context: ReferenceContext): Promise<ResolvedReference>
}
export interface ReferenceResolverPort {
  search(query: string, context: ReferenceContext): Promise<ReferenceSearchResult>
  resolve(
    selections: readonly ReferenceSelection[],
    context: ReferenceContext,
  ): Promise<import('@agnes/protocol').ContentBlock[]>
}
