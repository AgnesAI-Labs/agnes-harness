import type { TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { boundedCanonicalJson, utf8ByteLength } from './byte-budget.js'
import type { ValidationError } from './validate.js'

/** Interprets byte assertions preserved by schema code generation, including reference siblings. */
export function validateByteKeywords(schema: TSchema, value: unknown, path = ''): ValidationError[] {
  const references = new Map<string, TSchema>()
  const walk = (node: TSchema, item: unknown, location: string): ValidationError[] => {
    for (const [name, target] of Object.entries((node.$defs ?? {}) as Record<string, TSchema>)) {
      references.set(name, target)
      if (target.$id) references.set(target.$id, target)
    }
    if (node.$id) references.set(node.$id, node)
    const errors: ValidationError[] = []
    for (const keyword of ['x-max-utf8-bytes', 'x-max-canonical-json-bytes'] as const) {
      const limit = node[keyword] as number | undefined
      if (limit === undefined) continue
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error(`invalid ${keyword}`)
      const result =
        keyword === 'x-max-utf8-bytes'
          ? typeof item === 'string'
            ? utf8ByteLength(item, limit)
            : { ok: false }
          : boundedCanonicalJson(item, {
              maxBytes: limit,
              maxDepth: Number.MAX_SAFE_INTEGER,
              maxMembers: Number.MAX_SAFE_INTEGER,
            })
      if (!result.ok)
        errors.push({ path: location, code: 'RANGE', key: keyword, message: `value violates ${keyword}` })
    }
    if (node.$ref) {
      const target = references.get(node.$ref)
      if (!target) throw new Error(`unresolved byte schema reference ${node.$ref}`)
      errors.push(...walk(target, item, location))
    }
    for (const key of ['anyOf', 'oneOf'] as const) {
      const branches = node[key] as TSchema[] | undefined
      if (!branches) continue
      const matches = branches.filter(
        (branch) =>
          Value.Check(branch, [...references.values()], item) && walk(branch, item, location).length === 0,
      )
      if (key === 'oneOf' ? matches.length !== 1 : matches.length === 0)
        errors.push({ path: location, code: 'RANGE', message: `value violates byte assertions in ${key}` })
    }
    for (const branch of (node.allOf ?? []) as TSchema[]) errors.push(...walk(branch, item, location))
    if (node.type === 'array' && Array.isArray(item) && node.items) {
      item.forEach((child, index) => {
        errors.push(...walk(node.items as TSchema, child, `${location}/${index}`))
      })
    }
    if (node.type === 'object' && item !== null && typeof item === 'object') {
      const properties = node.properties as Record<string, TSchema> | undefined
      for (const [name, child] of Object.entries(item)) {
        const childPath = `${location}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`
        if (properties?.[name]) errors.push(...walk(properties[name], child, childPath))
        for (const [pattern, rule] of Object.entries(
          (node.patternProperties ?? {}) as Record<string, TSchema>,
        ))
          if (new RegExp(pattern).test(name)) errors.push(...walk(rule, child, childPath))
        if (!properties?.[name] && typeof node.additionalProperties === 'object')
          errors.push(...walk(node.additionalProperties, child, childPath))
      }
    }
    return errors
  }
  return walk(schema, value, path)
}
