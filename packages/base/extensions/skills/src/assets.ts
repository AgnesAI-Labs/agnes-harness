import { createHash } from 'node:crypto'
import { join, sep } from 'node:path'
import type { SkillFs } from './discover.js'
import { skillSha256 } from './frontmatter.js'

const sha256Bytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export const MAX_SKILL_TEXT_FILE_BYTES = 256 * 1024
export const MAX_SKILL_BINARY_FILE_BYTES = 1024 * 1024
export const MAX_SKILL_FILES = 32
export const MAX_SKILL_ATTACHMENT_BYTES = 4 * 1024 * 1024
/** Entries visited while collecting, so a linked Skill pointing at a large tree stays bounded. */
export const MAX_SKILL_ENTRIES_VISITED = 512
const MAX_RELATIVE_DEPTH = 4
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv'])
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const SEGMENT = /^[A-Za-z0-9._-]+$/
const decoder = new TextDecoder('utf-8', { fatal: true })

export type SkillFileKind = 'text' | 'binary'
export type SkillFile = Readonly<{
  relativePath: string
  sha256: string
  kind: SkillFileKind
  mime: string
  bytes: Uint8Array
}>

export function isSkillRelativePath(relativePath: string): boolean {
  if (
    !relativePath ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    relativePath.startsWith('/')
  )
    return false
  const segments = relativePath.split('/')
  // A SKILL.md at any depth is a Skill document (possibly a nested Skill), never an attachment.
  if (segments.length > MAX_RELATIVE_DEPTH || segments.at(-1) === 'SKILL.md') return false
  return segments.every(
    (segment) =>
      !segment.startsWith('.') &&
      segment !== 'node_modules' &&
      segment.length > 0 &&
      segment.length <= 255 &&
      SEGMENT.test(segment),
  )
}

function extensionOf(relativePath: string): string {
  const base = relativePath.split('/').at(-1) ?? ''
  const at = base.lastIndexOf('.')
  return at <= 0 ? '' : base.slice(at).toLocaleLowerCase('en-US')
}

function classify(relativePath: string): { kind: SkillFileKind; mime: string; limit: number } | undefined {
  const ext = extensionOf(relativePath)
  if (TEXT_EXT.has(ext))
    return {
      kind: 'text',
      mime:
        ext === '.json'
          ? 'application/json'
          : ext === '.csv'
            ? 'text/csv'
            : ext === '.yaml' || ext === '.yml'
              ? 'text/yaml'
              : 'text/markdown',
      limit: MAX_SKILL_TEXT_FILE_BYTES,
    }
  if (BINARY_EXT.has(ext))
    return {
      kind: 'binary',
      mime:
        ext === '.png'
          ? 'image/png'
          : ext === '.gif'
            ? 'image/gif'
            : ext === '.webp'
              ? 'image/webp'
              : 'image/jpeg',
      limit: MAX_SKILL_BINARY_FILE_BYTES,
    }
  if (relativePath.startsWith('scripts/')) {
    if (
      TEXT_EXT.has(ext) ||
      ext === '.sh' ||
      ext === '.js' ||
      ext === '.mjs' ||
      ext === '.py' ||
      ext === '.rb'
    )
      return { kind: 'text', mime: 'text/plain', limit: MAX_SKILL_TEXT_FILE_BYTES }
    return { kind: 'binary', mime: 'application/octet-stream', limit: MAX_SKILL_BINARY_FILE_BYTES }
  }
  return undefined
}

export function skillRevision(
  source: string,
  files: readonly Pick<SkillFile, 'relativePath' | 'sha256'>[],
): string {
  if (files.length === 0) return skillSha256(source)
  const manifest = [...files]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((file) => `${file.relativePath}\t${file.sha256}\n`)
    .join('')
  return skillSha256(`${source}\n${manifest}`)
}

function boundToRoot(rootReal: string, targetReal: string): boolean {
  if (targetReal === rootReal) return true
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`
  return targetReal.startsWith(prefix)
}

/**
 * Collects supported files under a Skill directory. A file that is unsupported, unreadable, outside
 * the Skill's real directory or over a budget is skipped on its own; the Skill itself is kept.
 */
export async function collectSkillFiles(
  fs: SkillFs,
  skillDir: string,
  skillReal?: string,
): Promise<readonly SkillFile[]> {
  const files: SkillFile[] = []
  let visited = 0
  let bytesTotal = 0
  const walk = async (relativeDir: string, depth: number): Promise<void> => {
    let entries: Awaited<ReturnType<SkillFs['list']>>
    try {
      entries = await fs.list(join(skillDir, relativeDir))
    } catch {
      return
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      visited += 1
      if (visited > MAX_SKILL_ENTRIES_VISITED || files.length >= MAX_SKILL_FILES) return
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.kind === 'dir') {
        if (depth < MAX_RELATIVE_DEPTH - 1 && isSkillRelativePath(`${relativePath}/x`))
          await walk(relativePath, depth + 1)
        continue
      }
      if (entry.kind !== 'file' || !isSkillRelativePath(relativePath)) continue
      const classified = classify(relativePath)
      if (!classified) continue
      const file = await readSkillFile(fs, join(skillDir, relativePath), classified, skillReal)
      if (!file || bytesTotal + file.byteLength > MAX_SKILL_ATTACHMENT_BYTES) continue
      bytesTotal += file.byteLength
      files.push(
        Object.freeze({
          relativePath,
          sha256: sha256Bytes(file),
          kind: classified.kind,
          mime: classified.mime,
          bytes: file,
        }),
      )
    }
  }
  await walk('', 0)
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return Object.freeze(files)
}

async function readSkillFile(
  fs: SkillFs,
  absolute: string,
  classified: { kind: SkillFileKind; limit: number },
  skillReal: string | undefined,
): Promise<Uint8Array | undefined> {
  try {
    if (fs.realpath && skillReal && !boundToRoot(skillReal, await fs.realpath(absolute))) return undefined
    const stat = await fs.stat(absolute)
    if (
      stat.kind !== 'file' ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 0 ||
      stat.size > classified.limit
    )
      return undefined
    const bytes = await fs.read(absolute)
    if (bytes.byteLength !== stat.size) return undefined
    if (classified.kind === 'text' && decoder.decode(bytes).includes('\0')) return undefined
    return bytes
  } catch {
    return undefined
  }
}
