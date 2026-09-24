import type { ContractStamp, RequestBody } from '@agnes/protocol'
import type { ContractStore } from './contract-store.js'
import { canonicalJson, sha256Hex } from './hash.js'

/**
 * Hashes exactly what the model was told about the tools: their names, descriptions and parameter
 * schemas, in the order they were disclosed. Key order and Unicode spelling are normalised away —
 * neither is something the model can see — so two identical disclosures hash alike, while any
 * change to a name, a description, a schema or the order of the list moves the digest.
 */
export function toolSchemaHash(tools: RequestBody['tools']): string {
  const disclosed = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
  // One normalisation, over the whole canonical form rather than field by field: it covers the
  // parameter schemas too, whose own property names can arrive in either spelling.
  return sha256Hex(canonicalJson(disclosed).normalize('NFC'))
}

export type SentReport = { sentHash: string; transforms: ContractStamp['transforms'] }

export function renderPrefixedPrompt(req: RequestBody, contract: ContractStore): Uint8Array {
  const system = new TextEncoder().encode(req.system)
  if (req.contractId === null) return system
  const prefix = contract.prefixBytes(req.contractId)
  const bytes = new Uint8Array(prefix.length + 1 + system.length)
  bytes.set(prefix)
  bytes[prefix.length] = 10
  bytes.set(system, prefix.length + 1)
  return bytes
}

/**
 * The stamp that opens every inference: it says which model was asked, under which contract, with
 * which tool disclosure and which parser rules, so a later reader can tell whether two turns were
 * produced under the same conditions without re-reading the request.
 */
export function buildStamp(
  req: RequestBody,
  contract: ContractStore,
  parserVersion: string,
  sent: SentReport | undefined,
): ContractStamp {
  return {
    prompt_prefix_hash: contract.prefixHash(req.contractId),
    tool_schema_hash: toolSchemaHash(req.tools),
    parser_version: parserVersion,
    contract_id: req.contractId,
    model: { route: req.route, id: req.model },
    derived_hash: req.derivedHash,
    sent_hash: sent?.sentHash ?? req.derivedHash,
    transforms: sent?.transforms ?? [{ event: 'sent_hash', ext: 'unreported' }],
  }
}
