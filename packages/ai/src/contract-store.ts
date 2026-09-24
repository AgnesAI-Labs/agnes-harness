import type { ToolSchema } from '@agnes/protocol'
import type { ContractSyntax } from './contract/types.js'

/** A loaded contract snapshot shared by request stamping and adapter configuration.
 * The loader validates artifact bytes at assembly; inference only reads the verified snapshot. */
export interface ContractStore {
  /** `null` when the request names no contract, or when the named one is not loaded: an external
   *  model has no prefix segment, and a stamp records that as an absent hash rather than a fake one. */
  prefixHash(contractId: string | null): string | null
  tools(contractId: string): ToolSchema[]
  syntax(contractId: string): ContractSyntax
  prefixBytes(contractId: string): Uint8Array
}

/**
 * The store an assembly uses when no contract artefact is fitted. It answers "no prefix" to every
 * hash question, which is the truthful answer, and refuses the bytes: a caller reaching for bytes
 * that do not exist has a configuration mistake, and silently handing back an empty buffer would
 * turn it into a wrong request instead of a stopped one.
 */
export class NullContractStore implements ContractStore {
  prefixHash(_contractId: string | null): null {
    return null
  }
  tools(_contractId: string): ToolSchema[] {
    return []
  }
  syntax(_contractId: string): ContractSyntax {
    return { toolCallFormats: ['native'] }
  }
  prefixBytes(contractId: string): never {
    throw new Error(`no contract loaded: ${contractId}`)
  }
}
