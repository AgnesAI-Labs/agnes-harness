import type { TSchema } from '@sinclair/typebox'
import {
  type ValidationError,
  type ValidationResult,
  validateAgainst,
} from '../../protocol-validation/src/validate.js'
import * as S from '../gen/ts/session-v1.js'
import { type ToolDef, ToolDef as ToolDefSchema } from '../gen/ts/tooldef.js'
import { EXT_EVENT_PATTERN } from './constants.js'
import { type RpcError, rpcError } from './errors.js'
import { validateRequestMedia } from './request-media.js'

export type { ValidationError, ValidationResult } from '../../protocol-validation/src/validate.js'
export { isDateTime, validateAgainst } from '../../protocol-validation/src/validate.js'

// The lookup table validateEvent's second stage reads: event type -> the generated TypeBox schema for
// that type's `data`. It is derived from the generated `X_AGNES_DATA` map rather than typed out, so
// the schema document is the only place the mapping is written. The hand-kept copy this replaces had
// drifted once already: an entry added to `x-agnes-data` and not to the table left that event type
// validated by envelope only, with `data` waved through as an arbitrary JsonValue.
export const DATA_DEFS: Record<string, TSchema> = Object.fromEntries(
  Object.entries(S.X_AGNES_DATA).map(([type, def]) => [
    type,
    (S as unknown as Record<string, TSchema>)[def] as TSchema,
  ]),
)

export function validateEvent(x: unknown): ValidationResult<S.EventEnvelope> {
  const env = validateAgainst<S.EventEnvelope>(S.EventEnvelope, x)
  if (!env.ok) return env
  const def = DATA_DEFS[env.value.type]
  if (!def) {
    // Every name in the closed event set has a data schema, so reaching here means the type is an
    // extension one (`x/...`), which this package deliberately does not know the shape of. A closed-set
    // name with no table entry would be a broken build, and is refused rather than waved through: the
    // second stage failing open is how an event type silently loses its only shape check.
    if (EXT_EVENT_PATTERN.test(env.value.type)) return env
    return { ok: false, errors: [{ path: '/type', message: 'no data schema', code: 'OTHER' }] }
  }
  const data = validateAgainst<unknown>(def, env.value.data, '/data')
  if (!data.ok) return { ok: false, errors: data.errors }
  if (env.value.type === 'request/header') {
    const media = (data.value as S.RequestHeader).media
    if (media !== undefined) {
      const checked = validateRequestMedia(media)
      if (!checked.ok)
        return {
          ok: false,
          errors: checked.errors.map((error) => ({
            ...error,
            path: `/data/media${error.path}`,
          })),
        }
    }
  }
  return env
}

export function toRpcError(errors: ValidationError[]): RpcError {
  const first = errors[0]
  if (!first) return rpcError('INVALID_PARAMS', { code: 'INVALID' })
  return rpcError('INVALID_PARAMS', {
    code: first.code === 'OTHER' ? 'INVALID' : first.code,
    ...(first.key ? { key: first.key } : {}),
    path: first.path,
  })
}

export function validateToolDef(x: unknown): ValidationResult<ToolDef> {
  return validateAgainst<ToolDef>(ToolDefSchema, x)
}
