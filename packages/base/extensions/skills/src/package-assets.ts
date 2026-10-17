import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import {
  classifySkillFile,
  collectSkillFiles,
  isSkillRelativePath,
  MAX_SKILL_ATTACHMENT_BYTES,
  MAX_SKILL_BINARY_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_TEXT_FILE_BYTES,
  type SkillFile,
} from './assets.js'
import { discoverPackageSkill } from './discover.js'

/** Private transport only; never included in a resource descriptor or management response. */
export type StoredPackageSkillFile = Readonly<{
  relativePath: string
  sha256: string
  kind: 'text' | 'binary'
  mime: string
  content: string
}>

export async function collectPackageSkillFiles(
  directory: string,
  source?: string,
): Promise<readonly StoredPackageSkillFile[]> {
  if (
    source !== undefined &&
    !discoverPackageSkill({
      packageId: 'validation',
      contributionId: 'skill',
      relativeLocation: './SKILL.md',
      source,
    })
  )
    throw Object.assign(new Error('invalid Skill document'), { code: 'SKILL_DOCUMENT_INVALID' })
  const files = await collectSkillFiles(
    {
      list: async (path) =>
        (await readdir(path, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          kind: entry.isSymbolicLink()
            ? 'symlink'
            : entry.isDirectory()
              ? 'dir'
              : entry.isFile()
                ? 'file'
                : 'other',
        })),
      stat: async (path) => {
        const value = await lstat(path)
        return { kind: value.isFile() ? 'file' : 'other', size: value.size, mtimeMs: value.mtimeMs }
      },
      read: readFile,
      realpath,
    },
    directory,
    await realpath(directory),
    { complete: true },
  )
  return files.map(({ bytes, ...file }) => ({ ...file, content: Buffer.from(bytes).toString('base64') }))
}

/** Only bounded, path-free diagnostics cross the private snapshot and management boundary. */
export function packageSkillLoadError(code: unknown) {
  switch (code) {
    case 'SKILL_ATTACHMENTS_LIMIT':
      return { code, message: 'Skill attachment count, size or traversal budget exceeded.' }
    case 'SKILL_ATTACHMENTS_UNREADABLE':
      return { code, message: 'A supported Skill attachment could not be read or validated.' }
    case 'SKILL_DOCUMENT_INVALID':
      return { code, message: 'Skill document metadata or body is invalid.' }
    default:
      return {
        code: 'SKILL_LOAD_FAILED',
        message: 'Skill document could not be loaded or exceeds its size limit.',
      }
  }
}

/** A supplied new field must validate completely; only an absent field means a legacy snapshot. */
export function decodePackageSkillFiles(value: unknown): readonly SkillFile[] | undefined {
  if (value === undefined) return undefined
  const invalid = (): never => {
    throw new Error('invalid package Skill attachments')
  }
  if (!Array.isArray(value) || value.length > MAX_SKILL_FILES) return invalid()
  const paths = new Set<string>()
  let total = 0
  return value.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return invalid()
    const file = row as Record<string, unknown>
    if (
      typeof file.relativePath !== 'string' ||
      !isSkillRelativePath(file.relativePath) ||
      paths.has(file.relativePath) ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      (file.kind !== 'text' && file.kind !== 'binary') ||
      typeof file.mime !== 'string' ||
      typeof file.content !== 'string' ||
      file.content.length > Math.ceil(MAX_SKILL_BINARY_FILE_BYTES / 3) * 4
    )
      return invalid()
    const bytes = Buffer.from(file.content, 'base64')
    const classified = classifySkillFile(file.relativePath)
    if (!classified || classified.kind !== file.kind || classified.mime !== file.mime) return invalid()
    if (
      bytes.toString('base64') !== file.content ||
      bytes.length > (file.kind === 'text' ? MAX_SKILL_TEXT_FILE_BYTES : MAX_SKILL_BINARY_FILE_BYTES) ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      return invalid()
    if (file.kind === 'text') {
      try {
        if (new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0')) return invalid()
      } catch {
        return invalid()
      }
    }
    total += bytes.length
    if (total > MAX_SKILL_ATTACHMENT_BYTES) return invalid()
    paths.add(file.relativePath)
    return Object.freeze({
      relativePath: file.relativePath,
      sha256: file.sha256,
      kind: file.kind,
      mime: file.mime,
      bytes,
    })
  })
}
