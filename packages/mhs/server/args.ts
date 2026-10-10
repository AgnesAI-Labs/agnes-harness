import type { InputSchema, ParamSchema } from '../gen/ts/mhs-v1.js'

export type Prepared =
  | { ok: true; args: Record<string, unknown>; notes: string[] }
  | { ok: false; detail: string }

class Invalid extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Validates call arguments against a tool's parameters as spec 6.4 says: wrong types, missing
 * required parameters and non-finite numbers are invalid; numbers outside their range are clamped and
 * strings longer than maxLength truncated, each with a note; unknown parameters are dropped; omitted
 * ones take their default.
 */
export function prepareArguments(schema: InputSchema, args: unknown): Prepared {
  const notes: string[] = []
  try {
    const value = prepareObject(schema.properties ?? {}, schema.required ?? [], args, '', notes)
    return { ok: true, args: value, notes }
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, detail: e.message }
    throw e
  }
}

function prepareObject(
  properties: Record<string, ParamSchema>,
  required: string[],
  value: unknown,
  path: string,
  notes: string[],
): Record<string, unknown> {
  if (!isObject(value)) throw new Invalid(`${path || 'arguments'} must be an object`)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value))
    if (!(key in properties)) notes.push(`dropped unknown parameter ${path}${key}`)
  for (const [key, param] of Object.entries(properties)) {
    const name = path + key
    if (value[key] !== undefined) out[key] = prepareValue(param, value[key], name, notes)
    else if (param.default !== undefined) {
      out[key] = param.default
      notes.push(`${name} defaulted to ${JSON.stringify(param.default)}`)
    } else if (required.includes(key)) throw new Invalid(`missing required parameter ${name}`)
  }
  return out
}

function prepareValue(param: ParamSchema, value: unknown, name: string, notes: string[]): unknown {
  if (param.enum !== undefined && !param.enum.some((e) => JSON.stringify(e) === JSON.stringify(value)))
    throw new Invalid(`${name} must be one of ${param.enum.map((e) => JSON.stringify(e)).join(', ')}`)
  switch (param.type) {
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Invalid(`${name} must be a finite number`)
      if (param.type === 'integer' && !Number.isInteger(value))
        throw new Invalid(`${name} must be an integer`)
      let n = value
      if (param.minimum !== undefined && n < param.minimum) n = param.minimum
      if (param.maximum !== undefined && n > param.maximum) n = param.maximum
      if (n !== value) notes.push(`${name} was ${value}, clamped to ${n}`)
      return n
    }
    case 'string': {
      if (typeof value !== 'string') throw new Invalid(`${name} must be a string`)
      if (param.maxLength !== undefined && [...value].length > param.maxLength) {
        notes.push(`${name} was truncated to ${param.maxLength} characters`)
        return [...value].slice(0, param.maxLength).join('')
      }
      return value
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw new Invalid(`${name} must be true or false`)
      return value
    case 'array': {
      if (!Array.isArray(value)) throw new Invalid(`${name} must be a list`)
      if (param.minItems !== undefined && value.length < param.minItems)
        throw new Invalid(`${name} needs at least ${param.minItems} items`)
      if (param.maxItems !== undefined && value.length > param.maxItems)
        throw new Invalid(`${name} takes at most ${param.maxItems} items`)
      const items = param.items
      return items === undefined ? value : value.map((v, i) => prepareValue(items, v, `${name}[${i}]`, notes))
    }
    case 'object':
      return prepareObject(param.properties ?? {}, param.required ?? [], value, `${name}.`, notes)
    default:
      return value
  }
}
