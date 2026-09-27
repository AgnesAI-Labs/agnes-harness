/**
 * Optional wrapping memo keyed by node sequence and the ledger-selected nonce. Correctness comes
 * from envelope epochs, not this map: a cold process may rebuild every string and get the same
 * bytes. Including nonce in the key prevents a failed, unsent derivation from locking a node to an
 * old turn's nonce.
 *
 * Each value is the ordered list of wrapped strings `toMessage` produced for that node's untrusted
 * blocks, in the order it visited them — not one string, because a user message can carry more
 * than one wrapped block and each gets its own id (see `wrapUntrusted`'s `block` parameter).
 */
export type EnvelopeCache = Map<string, readonly string[]>

export function createEnvelopeCache(): EnvelopeCache {
  return new Map()
}
