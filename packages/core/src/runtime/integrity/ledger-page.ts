import { jcs } from '@agnes/protocol'
import type { IntegrityVerifyResult } from '@agnes/protocol/runtime'
import { LEDGER_INTEGRITY_ALGORITHM, LedgerIntegrityFailure } from '../../log/integrity.js'
import { sha256Hex } from '../../request/hash.js'
import { parseIntegrityVerifyRequest } from './validation.js'

/** Verifies one bounded page without reading or modifying storage. */
export function verifyIntegrityLedgerPage(input: unknown): IntegrityVerifyResult {
  const checked = parseIntegrityVerifyRequest(input)
  if (checked.kind !== 'ledger-page') {
    throw new TypeError('invalid integrity ledger-page request')
  }
  const { initial, rows } = checked
  if (
    initial.legacyThroughSeq > initial.lastSeq ||
    (initial.headDigest === null && initial.legacyThroughSeq !== initial.lastSeq)
  ) {
    throw new LedgerIntegrityFailure('invalid ledger checkpoint')
  }
  let state = { ...initial }
  for (const row of rows) {
    const { event, integrity } = row
    if (state.lastSeq >= Number.MAX_SAFE_INTEGER || event.seq !== state.lastSeq + 1)
      throw new LedgerIntegrityFailure('ledger sequence is not contiguous')
    if (integrity === null) {
      if (state.headDigest !== null) throw new LedgerIntegrityFailure('legacy row follows protected history')
      state = { lastSeq: event.seq, legacyThroughSeq: event.seq, headDigest: null }
      continue
    }
    let payload: unknown
    if (integrity.mode === 'anchor') {
      if (state.headDigest !== null || integrity.previousDigest !== null) {
        throw new LedgerIntegrityFailure('invalid ledger anchor position')
      }
      payload = {
        algorithm: LEDGER_INTEGRITY_ALGORITHM,
        sessionKey: row.sessionKey,
        legacyThroughSeq: state.legacyThroughSeq,
        event,
      }
    } else {
      if (state.headDigest === null || integrity.previousDigest !== state.headDigest) {
        throw new LedgerIntegrityFailure('ledger chain predecessor mismatch')
      }
      payload = {
        algorithm: LEDGER_INTEGRITY_ALGORITHM,
        sessionKey: row.sessionKey,
        previousDigest: state.headDigest,
        event,
      }
    }
    if (sha256Hex(jcs(payload)) !== integrity.digest)
      throw new LedgerIntegrityFailure('ledger digest mismatch')
    state = { ...state, lastSeq: event.seq, headDigest: integrity.digest }
  }
  return { kind: 'ledger-page', checkpoint: state }
}
