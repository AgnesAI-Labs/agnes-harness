/** A selection is a locator, never caller-supplied context or a read grant. */
export interface ReferenceSelection {
  source: string
  id: string
}
export interface ReferenceCandidate extends ReferenceSelection {
  label: string
  description?: string
}
export interface ReferenceSearchResult {
  items: ReferenceCandidate[]
  truncated: boolean
}

/** Bound input before filesystem, history or plugin operations. */
export function validateReferenceSelections(input: unknown): ReferenceSelection[] {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > 8) throw new Error('Invalid references (maximum 8).')
  return input.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reference.')
    const { source, id } = value as ReferenceSelection
    if (
      Object.keys(value).sort().join(',') !== 'id,source' ||
      typeof source !== 'string' ||
      !/^[a-z][a-z0-9.-]{0,127}$/.test(source) ||
      typeof id !== 'string' ||
      !id ||
      id.length > 4096 ||
      Array.from(id).some((char) => char.charCodeAt(0) < 32)
    )
      throw new Error('Invalid reference.')
    return { source, id }
  })
}
