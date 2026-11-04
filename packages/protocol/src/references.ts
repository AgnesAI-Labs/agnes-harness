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

/** Only path-shaped file queries browse one directory. Plain names keep global search semantics. */
export function fileReferenceBrowse(query: string): { path: string; filter: string } | undefined {
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(query)) return undefined
  let value = query.trimStart()
  if (value === 'file') value = ''
  else if (/^file\s+/u.test(value)) value = value.replace(/^file\s+/u, '')
  else if (/^[^\s]+\s/u.test(value)) return undefined // another provider owns the prefix
  if (value.startsWith('"')) value = value.slice(1).replace(/"$/u, '')
  else if (/\s/u.test(value)) return undefined
  if (!value) return { path: '', filter: '' }
  value = value.replace(/\\/gu, '/')
  if (/^[A-Za-z]:/u.test(value) || value.startsWith('/') || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value))
    return undefined
  const parts = value.split('/')
  if (parts.some((part) => part === '.' || part === '..')) return undefined
  const path = parts.slice(0, -1).filter(Boolean).join('/')
  const filter = parts.at(-1) ?? ''
  if (!path && !value.includes('/')) return undefined
  return { path, filter }
}

/** The text after `@` that returns from an entered folder to its parent. */
export function parentFileReferenceBrowse(query: string): string | undefined {
  const browse = fileReferenceBrowse(query)
  if (!browse || browse.filter || !browse.path) return undefined
  const prefix = /^file\s+/u.test(query) ? 'file ' : ''
  const quoted = query.replace(/^file\s+/u, '').startsWith('"') ? '"' : ''
  const parent = browse.path.split('/').slice(0, -1).join('/')
  return `${prefix}${quoted}${parent ? `${parent}/` : ''}`
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
