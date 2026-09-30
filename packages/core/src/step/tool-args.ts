import type { ToolDef } from '@agnes/extension-api'
import { validateAgainst } from '@agnes/protocol'

/** Explain schema refusals without echoing argument values or relaxing validation. */
export function toolArgumentError(schema: ToolDef['parameters'], args: unknown): string | undefined {
  const prefix = 'tool arguments do not match the registered schema'
  try {
    const checked = validateAgainst(schema, args)
    if (checked.ok) return undefined
    const hints = checked.errors
      .filter((error) => error.code === 'MISSING')
      .slice(0, 5)
      .map((error) => `${`${error.path}/${error.key ?? '?'}`.slice(0, 160)}: missing required parameter`)
    return `${prefix}: ${hints.join('; ') || 'invalid parameter type or value'}. Retry with complete arguments matching the tool schema.`
  } catch {
    // A malformed schema must still refuse the call before policy or execution.
    return prefix
  }
}
