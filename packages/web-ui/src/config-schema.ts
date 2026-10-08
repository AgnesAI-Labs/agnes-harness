import { ProfileSchema } from '@agnes/protocol/gen/profile'

/** JSON-only configuration declarations. Backend validation and grants remain authoritative. */
export type ConfigSchema = Readonly<{
  type?: 'object' | 'string' | 'boolean' | 'number' | 'integer' | 'array'
  properties?: Readonly<Record<string, ConfigSchema>>
  required?: readonly string[]
  additionalProperties?: false
  items?: ConfigSchema
  enum?: readonly (string | number | boolean)[]
  anyOf?: readonly { const: string | number | boolean; type?: 'string' | 'number' | 'integer' | 'boolean' }[]
  const?: string | number | boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  pattern?: string
  format?: 'credential-reference'
  default?: unknown
  'x-ui'?: Readonly<{
    labelKey: string
    hintKey?: string
    placeholderKey?: string
    optionKeys?: Readonly<Record<string, string>>
    id?: string
    testId?: string
    control?: 'textarea' | 'checkbox' | 'text'
  }>
}>
export type ConfigIssue = Readonly<{
  path: string
  code: 'required' | 'type' | 'range' | 'choice' | 'pattern' | 'credential' | 'schema' | 'unknown'
}>
const keys = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'anyOf',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'pattern',
  'format',
  'default',
  'x-ui',
  'title',
  'description',
  '$id',
  '$schema',
])
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export const configChoices = (schema: ConfigSchema) =>
  schema.enum ??
  schema.anyOf?.map((entry) => entry.const) ??
  (schema.const !== undefined ? [schema.const] : undefined)

/** Refuse unsupported schemas, cycles and unsafe object keys instead of partially validating them. */
export function configSchemaSupported(schema: ConfigSchema): boolean {
  const active = new Set<object>()
  let count = 0
  function visit(value: unknown, depth: number): boolean {
    if (!object(value) || depth > 12 || ++count > 256 || active.has(value)) return false
    if (Object.keys(value).some((key) => !keys.has(key))) return false
    active.add(value)
    const s = value as ConfigSchema
    const choices = configChoices(s)
    if (s.enum && s.anyOf) return false
    if (
      s.type !== undefined &&
      !['object', 'string', 'boolean', 'number', 'integer', 'array'].includes(s.type)
    )
      return false
    if (s.uniqueItems !== undefined && typeof s.uniqueItems !== 'boolean') return false
    if (
      s.required !== undefined &&
      (!Array.isArray(s.required) || s.required.some((key) => typeof key !== 'string'))
    )
      return false
    let valid =
      !choices ||
      (choices.length > 0 &&
        choices.length <= 128 &&
        choices.every(
          (v) =>
            ['string', 'number', 'boolean'].includes(typeof v) &&
            (typeof v !== 'number' || Number.isFinite(v)),
        ))
    const ui = s['x-ui']
    if (
      ui &&
      (!object(ui) ||
        typeof ui.labelKey !== 'string' ||
        !ui.labelKey ||
        Object.keys(ui).some(
          (key) =>
            !['labelKey', 'hintKey', 'placeholderKey', 'optionKeys', 'id', 'testId', 'control'].includes(key),
        ) ||
        ['hintKey', 'placeholderKey', 'id', 'testId'].some(
          (key) => ui[key as 'id'] !== undefined && typeof ui[key as 'id'] !== 'string',
        ) ||
        (ui.optionKeys !== undefined &&
          (!object(ui.optionKeys) ||
            Object.values(ui.optionKeys).some((value) => typeof value !== 'string' || !value))) ||
        (ui.control !== undefined && !['textarea', 'checkbox', 'text'].includes(ui.control)))
    )
      valid = false
    if (choices && new Set(choices.map(String)).size !== choices.length) valid = false
    if ((s.minLength !== undefined || s.maxLength !== undefined) && s.type !== 'string') valid = false
    if (
      (s.minItems !== undefined || s.maxItems !== undefined || s.uniqueItems !== undefined) &&
      s.type !== 'array'
    )
      valid = false
    if ((s.required !== undefined || s.additionalProperties !== undefined) && s.type !== 'object')
      valid = false
    if (s.properties && s.type !== 'object') valid = false
    if (s.items && s.type !== 'array') valid = false
    if (s.pattern && s.type !== 'string') valid = false
    if ((s.minimum !== undefined || s.maximum !== undefined) && s.type !== 'number' && s.type !== 'integer')
      valid = false
    if (
      s.anyOf &&
      !s.anyOf.every(
        (entry) =>
          Object.keys(entry).every((key) => key === 'const' || key === 'type') &&
          Object.hasOwn(entry, 'const') &&
          (entry.type === undefined ||
            entry.type === typeof entry.const ||
            (entry.type === 'integer' && Number.isInteger(entry.const))),
      )
    )
      valid = false
    valid &&= !s.format || s.format === 'credential-reference'
    valid &&= !s.format || s.type === 'string'
    if (s.pattern) {
      try {
        new RegExp(s.pattern)
      } catch {
        valid = false
      }
      valid &&= s.pattern.length <= 512
    }
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const)
      if (
        s[key] !== undefined &&
        (!Number.isFinite(s[key]) ||
          (key !== 'minimum' && key !== 'maximum' && (Number(s[key]) < 0 || !Number.isInteger(s[key]))))
      )
        valid = false
    if (s.type === 'object') {
      valid &&= object(s.properties) && s.additionalProperties === false
      valid &&= Object.entries(s.properties ?? {}).every(
        ([key, child]) => !['__proto__', 'prototype', 'constructor'].includes(key) && visit(child, depth + 1),
      )
      valid &&= !s.required || s.required.every((key) => Object.hasOwn(s.properties ?? {}, key))
    } else if (s.type === 'array')
      valid &&= !!s.items && s.items.type === 'string' && visit(s.items, depth + 1)
    else
      valid &&=
        !!choices ||
        s.const !== undefined ||
        ['string', 'boolean', 'number', 'integer'].includes(s.type ?? '')
    active.delete(value)
    return valid
  }
  try {
    return visit(schema, 0)
  } catch {
    return false
  }
}

/** No coercion, mutation, secrets in errors, or automatic defaults during validation. */
export function configIssues(schema: ConfigSchema, value: unknown): readonly ConfigIssue[] {
  if (!configSchemaSupported(schema)) return [{ path: '', code: 'schema' }]
  const issues: ConfigIssue[] = []
  const issue = (path: string, code: ConfigIssue['code']) => {
    issues.push({ path, code })
  }
  function check(s: ConfigSchema, data: unknown, path: string) {
    const choices = configChoices(s)
    if (choices && !choices.includes(data as string)) {
      issue(path, 'choice')
      return
    }
    if (s.const !== undefined && data !== s.const) {
      issue(path, 'choice')
      return
    }
    if (s.type === 'object') {
      if (!object(data)) {
        issue(path, 'type')
        return
      }
      for (const key of Object.keys(data))
        if (!Object.hasOwn(s.properties ?? {}, key))
          issue(`${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, 'unknown')
      for (const [key, child] of Object.entries(s.properties ?? {})) {
        const next = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
        if (!Object.hasOwn(data, key) || data[key] === undefined) {
          if (s.required?.includes(key)) issue(next, 'required')
          continue
        }
        check(child, data[key], next)
      }
    } else if (s.type === 'array') {
      if (!Array.isArray(data)) {
        issue(path, 'type')
        return
      }
      if (
        (s.minItems !== undefined && data.length < s.minItems) ||
        (s.maxItems !== undefined && data.length > s.maxItems) ||
        (s.uniqueItems && new Set(data).size !== data.length)
      )
        issue(path, 'range')
      for (const [index, item] of data.entries()) if (s.items) check(s.items, item, `${path}/${index}`)
    } else if (s.type === 'string') {
      if (typeof data !== 'string') {
        issue(path, 'type')
        return
      }
      if ((s.minLength !== undefined && data.length < s.minLength) || data.length > (s.maxLength ?? 65536)) {
        issue(path, 'range')
        return
      }
      if (
        s.format === 'credential-reference' &&
        !new RegExp(ProfileSchema.Import('SecretRef').$defs.SecretRef.pattern ?? '(?!)').test(data)
      )
        issue(path, 'credential')
      if (s.pattern && !new RegExp(s.pattern).test(data)) issue(path, 'pattern')
    } else if (s.type === 'boolean') {
      if (typeof data !== 'boolean') issue(path, 'type')
    } else if (s.type === 'number' || s.type === 'integer') {
      if (
        typeof data !== 'number' ||
        !Number.isFinite(data) ||
        (s.type === 'integer' && !Number.isInteger(data))
      )
        issue(path, 'type')
      else if ((s.minimum !== undefined && data < s.minimum) || (s.maximum !== undefined && data > s.maximum))
        issue(path, 'range')
    }
  }
  check(schema, value, '')
  return issues
}
