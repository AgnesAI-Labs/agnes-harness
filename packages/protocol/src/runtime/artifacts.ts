// generated from schema/runtime by tools/gen-runtime.ts — do not edit

import { RuntimeErrorDetails, RuntimeErrorHttpDefaults } from '../../gen/ts/runtime-artifact-policy.js'
import type { RuntimeError, ValidationResult } from './public.js'
import { validateRuntime } from './public.js'

export {
  RuntimeArtifactPolicy,
  RuntimeErrorDetails,
  RuntimeErrorHttpDefaults,
} from '../../gen/ts/runtime-artifact-policy.js'

/** Unknown detail extensions keep their code; reserved details cannot change classification. */
export function validateRuntimeErrorDetail(value: unknown): ValidationResult<RuntimeError> {
  const result = validateRuntime('RuntimeError', value)
  if (!result.ok) return result
  const error = result.value
  const rules: Readonly<
    Record<string, { readonly code: string; readonly retryAdviceKinds: readonly string[] }>
  > = RuntimeErrorDetails
  const rule = Object.hasOwn(rules, error.detailCode) ? rules[error.detailCode] : undefined
  if (
    (rule && (rule.code !== error.code || !rule.retryAdviceKinds.includes(error.retryAdvice.kind))) ||
    (error.code === 'unknown_effect' && error.retryAdvice.kind !== 'reconcile')
  )
    return {
      ok: false,
      errors: [{ path: '/detailCode', message: 'runtime error classification mismatch', code: 'ENUM' }],
    }
  return result
}

/** HTTP status is a presentation mapping, never proof of business admission or retry permission. */
export function runtimeErrorHttpStatus(value: RuntimeError): number {
  const checked = validateRuntimeErrorDetail(value)
  if (!checked.ok) throw new TypeError('invalid runtime error classification')
  const rules: Readonly<Record<string, { readonly httpStatus: number }>> = RuntimeErrorDetails
  return (
    (Object.hasOwn(rules, checked.value.detailCode)
      ? rules[checked.value.detailCode]?.httpStatus
      : undefined) ?? RuntimeErrorHttpDefaults[checked.value.code]
  )
}
