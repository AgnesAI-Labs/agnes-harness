import { createHash } from 'node:crypto'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'

export type SkillFrontmatter = Readonly<{
  name: string
  description: string
  /** A deterministic digest of the reviewed static capability declaration. */
  capabilityHash: string
}>

const MAX_FRONTMATTER_BYTES = 16 * 1024
const MAX_NAME_LENGTH = 128
/** Agent Skills specification: description is 1–1024 characters. */
const MAX_DESCRIPTION_LENGTH = 1024

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })

function staticNode(node: unknown): boolean {
  if (node === null || node === undefined || isScalar(node)) return true
  if (isSeq(node)) return node.items.every(staticNode)
  if (isMap(node)) return node.items.every((pair) => isScalar(pair.key) && staticNode(pair.value))
  return false
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null)
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  throw new TypeError('frontmatter is not static')
}

/** Parse only a plain, bounded YAML frontmatter block. Candidate bodies are never interpreted. */
export function parseSkillDocument(
  source: string,
): Readonly<{ frontmatter: SkillFrontmatter; body: string }> | undefined {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return undefined
  const closing = /^---\r?\n([\s\S]{0,16384}?)^---[ \t]*\r?\n/m.exec(source)
  if (
    !closing?.[1] ||
    closing.index === undefined ||
    Buffer.byteLength(closing[1], 'utf8') > MAX_FRONTMATTER_BYTES
  )
    return undefined
  const doc = parseDocument(closing[1], { uniqueKeys: true, prettyErrors: false })
  if (doc.errors.length || !isMap(doc.contents) || !staticNode(doc.contents)) return undefined
  const data = doc.toJS({ mapAsMap: false })
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const raw = data as Record<string, unknown>
  const name = raw.name
  const description = raw.description
  if (
    typeof name !== 'string' ||
    typeof description !== 'string' ||
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    description.length === 0 ||
    description.length > MAX_DESCRIPTION_LENGTH ||
    hasControlCharacter(name)
  )
    return undefined
  const frontmatter = Object.freeze({ name, description, capabilityHash: sha256(canonical(raw)) })
  return Object.freeze({ frontmatter, body: source.slice(closing.index + closing[0].length) })
}

export const parseSkillFrontmatter = (source: string): SkillFrontmatter | undefined =>
  parseSkillDocument(source)?.frontmatter

export const normalizeSkillName = (name: string): string =>
  name.trim().normalize('NFKC').toLocaleLowerCase('en-US')
export const skillSha256 = sha256
