/** The immutable identity persisted on a session. */
export interface LoopSelection {
  id: string
  version: string
}

export function parseLoopSelection(value: unknown): LoopSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('loop requires { id, version }')
  const { id, version } = value as Record<string, unknown>
  if (
    typeof id !== 'string' ||
    !id.trim() ||
    id.length > 256 ||
    /[\s\x00-\x1f\x7f]/.test(id) ||
    typeof version !== 'string' ||
    !version.trim() ||
    version.length > 64 ||
    /[\s\x00-\x1f\x7f]/.test(version)
  )
    throw new TypeError('loop requires a nonempty id and version without whitespace')
  return { id, version }
}

/** Splitting at the last @ also accepts scoped loop ids. */
export function parseLoopSpecifier(value: string): LoopSelection {
  const separator = value.lastIndexOf('@')
  if (separator <= 0) throw new TypeError('loop expects id@version')
  return parseLoopSelection({ id: value.slice(0, separator), version: value.slice(separator + 1) })
}
