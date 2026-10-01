import type { ValidationResult } from '../../../protocol-validation/src/validate.js'
import { RuntimeHttpHeaderPolicy } from '../../gen/ts/runtime-catalog.js'
import type { ControlledHttpHeaders } from '../../gen/ts/runtime-public.js'
import { validateRuntime } from './public.js'

/** The direction rules are generated from the same authority as the closed header codec. */
export function validateControlledHttpHeaders(
  direction: 'request' | 'response',
  value: unknown,
): ValidationResult<ControlledHttpHeaders> {
  const result = validateRuntime('ControlledHttpHeaders', value)
  if (!result.ok) return result
  const allowed: readonly string[] = RuntimeHttpHeaderPolicy[direction]
  if (!allowed)
    return { ok: false, errors: [{ path: '', code: 'ENUM', message: 'invalid header direction' }] }
  const forbidden = Object.keys(result.value).filter((name) => !allowed.includes(name))
  if (forbidden.length)
    return {
      ok: false,
      errors: forbidden.map((name) => ({
        path: `/${name}`,
        code: 'UNKNOWN_KEY',
        message: 'header forbidden in this direction',
        key: name,
      })),
    }
  return result
}
