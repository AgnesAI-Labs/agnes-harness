import type {
  IntegrityCanonicalizeRequest,
  IntegrityCanonicalizeResult,
  IntegrityVerifyRequest,
  IntegrityVerifyResult,
  LedgerIntegrityRow,
  RuntimeWireTypes,
} from '@agnes/extension-api/runtime'
import { RuntimeServiceCatalog, validateRuntime } from '@agnes/protocol/runtime'

const methods = RuntimeServiceCatalog['agh.integrity'].methods
export const canonicalInput: RuntimeWireTypes[typeof methods.canonicalize.input] = {
  value: { message: 'hello' },
} satisfies IntegrityCanonicalizeRequest
export const canonicalOutput: RuntimeWireTypes[typeof methods.canonicalize.output] = {
  canonical: 'null',
  digest: 'a'.repeat(64),
  bytes: 4,
} satisfies IntegrityCanonicalizeResult
declare const rows: readonly LedgerIntegrityRow[]
export const verifyInput: RuntimeWireTypes[typeof methods.verify.input] = {
  kind: 'ledger-page',
  algorithm: 'agnes-ledger-jcs-sha256-v1',
  initial: { lastSeq: 0, legacyThroughSeq: 0, headDigest: null },
  rows: [...rows],
} satisfies IntegrityVerifyRequest
export const verifyOutput: RuntimeWireTypes[typeof methods.verify.output] = {
  kind: 'ledger-page',
  checkpoint: { lastSeq: 0, legacyThroughSeq: 0, headDigest: null },
} satisfies IntegrityVerifyResult

const parsed = validateRuntime(methods.verify.input, verifyInput)
if (parsed.ok) {
  const request: IntegrityVerifyRequest = parsed.value
  if (request.kind === 'ledger-page') {
    const physicalOwner: string | undefined = request.rows[0]?.sessionKey
    void physicalOwner
    // @ts-expect-error Ledger pages do not carry commit-manifest material.
    request.mutations
  } else {
    const count: number = request.commit.mutationCount
    void count
    // @ts-expect-error Commit manifests do not carry ledger rows.
    request.rows
  }
}
// @ts-expect-error Canonicalization requires its closed value envelope.
export const missingValue: IntegrityCanonicalizeRequest = {}
// @ts-expect-error A canonicalization result cannot replace a canonicalization request.
export const responseAsRequest: IntegrityCanonicalizeRequest = canonicalOutput
export const incompleteRow: LedgerIntegrityRow = {
  sessionKey: 'parent',
  // @ts-expect-error Ledger rows require the complete official event envelope.
  event: { seq: 1, data: {} },
  integrity: null,
}
// @ts-expect-error Compute inputs and outputs use distinct discriminator shapes.
export const wrongVerifyInput: IntegrityVerifyRequest = verifyOutput
