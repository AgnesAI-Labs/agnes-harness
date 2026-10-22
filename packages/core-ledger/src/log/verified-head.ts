import { sha256Hex } from '@agnes/core-common/request/hash'
import type { Seq, SessionKey } from '@agnes/core-common/types'
import type { PersistenceVerifiedHead } from '@agnes/extension-api'
import { jcs } from '@agnes/protocol'
import { LEDGER_INTEGRITY_ALGORITHM } from './integrity.js'
import type { StorageAdapter } from './storage.js'

export const VERIFIED_HEAD_ALGORITHM = 'agnes-ledger-checkpoint-v1' as const

/**
 * A hash-verified prefix followed only by locally hashed appends. A checkpoint accelerates open;
 * every process rehashes the prefix in the background before using history as evidence.
 * It cannot defend against an attacker rewriting both ledger and checkpoint; external anchors are separate.
 */
export type VerifiedHead = PersistenceVerifiedHead

export function verifiedHeadDigest(h: Omit<VerifiedHead, 'checkpointDigest' | 'writtenAtMs'>): string {
  return sha256Hex(
    jcs({
      algorithm: VERIFIED_HEAD_ALGORITHM,
      ledgerAlgorithm: h.algorithm,
      sessionKey: h.sessionKey,
      throughSeq: h.throughSeq,
      headDigest: h.headDigest,
      legacyThroughSeq: h.legacyThroughSeq,
      verifiedFullAtMs: h.verifiedFullAtMs,
    }),
  )
}

export function makeVerifiedHead(h: Omit<VerifiedHead, 'checkpointDigest'>): VerifiedHead {
  return { ...h, checkpointDigest: verifiedHeadDigest(h) }
}

export type CheckpointDecision =
  | { use: true; head: VerifiedHead }
  | {
      use: false
      reason: 'absent' | 'unsupported' | 'self-check' | 'beyond-head' | 'row-mismatch' | 'algorithm'
    }

const DIGEST = /^[0-9a-f]{64}$/

/**
 * A checkpoint is used only when all three hold: it hashes to its own digest, it does not reach past
 * the stored head, and the stored digest of its last row is the digest it names. Anything else is
 * dropped silently and the ledger is opened as without a checkpoint.
 */
export async function decideCheckpoint(
  storage: StorageAdapter,
  key: SessionKey,
  lastSeq: Seq,
): Promise<CheckpointDecision> {
  if (!storage.readVerifiedHead || !storage.integrityDigestAt) return { use: false, reason: 'unsupported' }
  const head = await storage.readVerifiedHead(key)
  if (!head || head.sessionKey !== key) return { use: false, reason: 'absent' }
  if (head.algorithm !== LEDGER_INTEGRITY_ALGORITHM) return { use: false, reason: 'algorithm' }
  if (
    typeof head.checkpointDigest !== 'string' ||
    verifiedHeadDigest(head) !== head.checkpointDigest ||
    // A protected head always has a digest and at least one protected row after the legacy prefix.
    typeof head.headDigest !== 'string' ||
    !DIGEST.test(head.headDigest) ||
    !Number.isSafeInteger(head.legacyThroughSeq) ||
    head.legacyThroughSeq < 0 ||
    head.legacyThroughSeq >= head.throughSeq
  )
    return { use: false, reason: 'self-check' }
  if (!Number.isSafeInteger(head.throughSeq) || head.throughSeq > lastSeq || head.throughSeq < 1)
    return { use: false, reason: 'beyond-head' }
  if ((await storage.integrityDigestAt(key, head.throughSeq)) !== head.headDigest)
    return { use: false, reason: 'row-mismatch' }
  return { use: true, head }
}
