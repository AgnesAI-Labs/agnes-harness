import type { ToolDef } from '@agnes/extension-api'
import { validateAgainst } from '@agnes/protocol'

/** Explain schema refusals without echoing argument values or relaxing validation. */
export function toolArgumentError(schema: ToolDef['parameters'], args: unknown): string | undefined {
  const prefix = 'tool arguments do not match the registered schema'
  try {
    const checked = validateAgainst(schema, args)
    if (checked.ok) return undefined
    const hints = checked.errors.slice(0, 5).map((error) => {
      const pointer = error.code === 'MISSING' ? `${error.path}/${error.key ?? '?'}` : error.path
      let field = schema
      const safePath: string[] = []
      for (const encoded of pointer.split('/').slice(1)) {
        const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~')
        if (field.properties && Object.hasOwn(field.properties, key)) {
          field = field.properties[key]
          safePath.push(encoded.slice(0, 80))
        } else if (field.type === 'array' && /^\d+$/.test(key) && field.items) {
          field = field.items
          safePath.push(key.slice(0, 8))
        } else {
          safePath.push('<unknown>')
          break
        }
      }
      const labels = {
        MISSING: 'missing required parameter',
        TYPE: 'incorrect parameter type',
        ENUM: 'choose an allowed value',
        PATTERN: 'does not match the required format',
        RANGE: 'outside the allowed range',
        UNKNOWN_KEY: 'unknown parameter',
        OTHER: 'invalid parameter',
      }
      const literals = (field.anyOf ?? [field])
        .flatMap((entry: { const?: unknown }) =>
          typeof entry.const === 'string' && /^[\w .:/-]{1,48}$/.test(entry.const) ? [entry.const] : [],
        )
        .slice(0, 8)
      return `${('/' + safePath.join('/')).slice(0, 160)}: ${labels[error.code]}${error.code === 'ENUM' && literals.length ? ` (${literals.join(', ')})` : ''}`
    })
    return `${prefix}: ${hints.join('; ') || 'invalid parameter type or value'}. Retry with complete arguments matching the tool schema.`
  } catch {
    // A malformed schema must still refuse the call before policy or execution.
    return prefix
  }
}
