import type { IntegrityVerifyResult } from '@agnes/protocol/runtime'
import { verifyIntegrityCommitManifest } from './commit-manifest.js'
import { verifyIntegrityLedgerPage } from './ledger-page.js'
import { parseIntegrityVerifyRequest } from './validation.js'

export function verifyIntegrity(input: unknown): IntegrityVerifyResult {
  const request = parseIntegrityVerifyRequest(input)
  return request.kind === 'ledger-page'
    ? verifyIntegrityLedgerPage(request)
    : verifyIntegrityCommitManifest(request)
}
