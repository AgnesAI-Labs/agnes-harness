import {
  boundedCanonicalJson,
  type IntegrityVerifyRequest,
  RuntimeAuthorCodecPolicy,
  type RuntimeError,
  validateRuntime,
  validateRuntimeErrorDetail,
} from '@agnes/protocol/runtime'

export class IntegrityFailure extends TypeError {
  readonly error: RuntimeError
  constructor(code: RuntimeError['code'], detailCode: string) {
    super('Integrity operation refused')
    this.error = {
      code,
      detailCode,
      message: this.message,
      diagnosticId: 'integrity-provider',
      retryAdvice: { kind: code === 'timeout' ? 'retry_read' : 'never' },
    }
  }
}
export function failIntegrity(code: RuntimeError['code'], detailCode: string): never {
  throw new IntegrityFailure(code, detailCode)
}
export function parseIntegrityVerifyRequest(input: unknown): IntegrityVerifyRequest {
  const safe = boundedCanonicalJson(input, {
    maxBytes: RuntimeAuthorCodecPolicy.payload.maxCanonicalJsonBytes,
    maxDepth: RuntimeAuthorCodecPolicy.payload.maxDepth,
    maxMembers: RuntimeAuthorCodecPolicy.payload.maxMembers,
  })
  if (!safe.ok)
    failIntegrity(
      safe.errors.some((error) => error.code === 'RANGE') ? 'quota' : 'invalid_input',
      'integrity_input_invalid',
    )
  const value = safe.value.json
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.kind === 'ledger-page') {
      if (value.algorithm !== 'agnes-ledger-jcs-sha256-v1')
        failIntegrity('incompatible', 'integrity_format_unsupported')
      if (Array.isArray(value.rows) && value.rows.length > 500) failIntegrity('quota', 'integrity_page_limit')
    } else if (value.kind === 'commit-manifest') {
      if (
        (Array.isArray(value.mutations) && value.mutations.length > 10000) ||
        (Array.isArray(value.sideEntries) && value.sideEntries.length > 10000)
      )
        failIntegrity('quota', 'integrity_manifest_limit')
    }
  }
  const checked = validateRuntime('IntegrityVerifyRequest', value)
  if (!checked.ok) failIntegrity('invalid_input', 'integrity_input_invalid')
  return checked.value
}

export function checkedIntegrityRefusal(error: RuntimeError): RuntimeError {
  const checked = validateRuntimeErrorDetail(error)
  if (!checked.ok) failIntegrity('internal', 'invalid_runtime_error')
  return checked.value
}
