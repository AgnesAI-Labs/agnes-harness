import type { ToolDef } from '@agnes/extension-api'
import { validateAgainst } from '@agnes/protocol'
import type { TSchema } from '@sinclair/typebox'

const escapePointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1')
const literals = (schema: TSchema): unknown[] =>
  schema.enum ??
  (Object.hasOwn(schema, 'const') ? [schema.const] : (schema.anyOf ?? schema.oneOf ?? []).flatMap(literals))

/** Schema refusals precede execute. Array indices are zero-based; null names the whole call. */
export function toolArgumentFeedback(hint: string) {
  const item = hint.match(/\/(\d+)(?:\/|:)/)?.[1]
  return { category: 'invalid_args', index: item === undefined ? null : Number(item), written: false, hint }
}

/** Explain schema refusals without echoing supplied values or unknown property names. */
export function toolArgumentError(schema: ToolDef['parameters'], args: unknown): string | undefined {
  const prefix = 'tool arguments do not match the registered schema'
  try {
    if (validateAgainst(schema, args).ok) return undefined
    const definitions: Record<string, TSchema> = schema.$defs ?? {}
    const resolve = (field: TSchema): TSchema => {
      for (let i = 0; typeof field.$ref === 'string' && i < 16; i++) {
        const key = field.$ref.replace(/^#\/\$defs\//, '')
        const next = definitions[key] ?? Object.values(definitions).find((d) => d.$id === field.$ref)
        if (!next || next === field) break
        field = next
      }
      return field
    }
    const check = (field: TSchema, value: unknown) => validateAgainst({ ...field, $defs: definitions }, value)
    const hints: string[] = []
    const visit = (raw: TSchema, value: unknown, path: string, depth: number): void => {
      if (hints.length >= 5 || depth > 32) return
      const field = resolve(raw)
      const checked = check(field, value)
      if (checked.ok) return
      const variants: TSchema[] | undefined = field.anyOf ?? field.oneOf
      if (variants && !variants.every((v) => Object.hasOwn(resolve(v), 'const'))) {
        // Prefer the branch named by a declared discriminator (kind, type, etc.). Never print it.
        const matches = variants
          .map(resolve)
          .filter(
            (v) =>
              value &&
              typeof value === 'object' &&
              Object.entries<TSchema>(v.properties ?? {}).some(([key, p]) =>
                literals(resolve(p)).includes((value as Record<string, unknown>)[key]),
              ),
          )
        const candidates = matches.length ? matches : variants.map(resolve)
        const best = candidates.reduce(
          (a, b) => {
            const result = check(b, value)
            return !result.ok && result.errors.length < a.errors
              ? { field: b, errors: result.errors.length }
              : a
          },
          { field: candidates[0] as TSchema, errors: Infinity },
        )
        visit(best.field, value, path, depth + 1)
        return
      }
      const start = hints.length
      if (field.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
        const properties: Record<string, TSchema> = field.properties ?? {}
        const record = value as Record<string, unknown>
        for (const key of field.required ?? [])
          if (!Object.hasOwn(record, key))
            hints.push(`${path}/${escapePointer(key)}: missing required parameter`)
        for (const [key, child] of Object.entries(properties))
          if (Object.hasOwn(record, key))
            visit(child, record[key], `${path}/${escapePointer(key)}`, depth + 1)
        if (
          field.additionalProperties === false &&
          Object.keys(record).some((key) => !Object.hasOwn(properties, key))
        )
          hints.push(
            `${path || '/'}: unknown parameter; allowed fields: ${Object.keys(properties).join(', ')}`,
          )
      } else if (field.type === 'array' && Array.isArray(value) && field.items) {
        for (let i = 0; i < value.length && hints.length < 5; i++)
          visit(field.items, value[i], `${path}/${i}`, depth + 1)
      }
      if (hints.length > start) return
      const allowed = literals(field)
      const bounds = [
        'minimum',
        'maximum',
        'exclusiveMinimum',
        'exclusiveMaximum',
        'minLength',
        'maxLength',
        'minItems',
        'maxItems',
      ]
        .filter((key) => typeof field[key] === 'number')
        .map((key) => `${key}=${field[key]}`)
        .join(', ')
      const code = checked.errors[0]?.code
      const detail = allowed.length
        ? `choose an allowed value (${allowed.map((v) => JSON.stringify(v)).join(', ')})`
        : code === 'RANGE'
          ? `outside the allowed range (${bounds})`
          : code === 'PATTERN'
            ? `required format: ${field.pattern ?? field.format ?? 'see schema'}`
            : `incorrect parameter type; expected ${field.type ?? 'the declared schema'}${bounds ? ` (${bounds})` : ''}`
      hints.push(`${path || '/'}: ${detail}`)
    }
    visit(schema, args, '', 0)
    return `${prefix}: ${hints.slice(0, 5).join('; ').slice(0, 1800)}. Retry with complete arguments matching the tool schema.`
  } catch {
    // Malformed schemas still refuse dispatch before policy or effects.
    return `${prefix}; schema could not be interpreted. Continue without this tool.`
  }
}
