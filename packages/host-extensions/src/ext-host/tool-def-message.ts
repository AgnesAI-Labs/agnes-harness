/** The refusal an extension author sees for a tool definition that fails `checkToolDef`. */
export function invalidToolMessage(name: unknown, problems: readonly string[]): string {
  const label = typeof name === 'string' ? `${name.slice(0, 128)}: ` : ''
  return `invalid tool definition ${label}${problems.join('; ')}`
}
