import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isSkillBundlePath, SKILL_BUNDLE_FRONTMATTER_KEYS, SKILL_BUNDLE_LIMITS } from '@agnes/protocol'
import { isMap, parseDocument } from 'yaml'

const refused = (code: string): never => {
  throw Object.assign(new Error(code), { code })
}
function supportedSkillDocument(directory: string): boolean {
  const path = join(directory, 'SKILL.md')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) return false
  const source = readFileSync(path, 'utf8')
  const header = /^---\r?\n([\s\S]{0,16384}?)^---[ \t]*\r?\n/m.exec(source)
  if (!header?.[1] || header.index !== 0) return false
  const document = parseDocument(header[1], { uniqueKeys: true, prettyErrors: false })
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) return false
  let value: Record<string, unknown>
  try {
    value = document.toJS({ maxAliasCount: 0 })
  } catch {
    return false
  }
  return Object.keys(value).every((key) => SKILL_BUNDLE_FRONTMATTER_KEYS.includes(key))
}
const json = (directory: string, file: string): Record<string, unknown> | undefined => {
  try {
    const path = join(directory, file)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024)
      return refused('SKILL_MANIFEST_INVALID')
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return refused('SKILL_MANIFEST_INVALID')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Reads declarations only. Neither package entry points nor YAML expressions are evaluated. */
export function selectSkillSource(
  directory: string,
  subdirectory?: string,
): { directory?: string; candidates: string[]; reason?: string } {
  if (subdirectory && !isSkillBundlePath(subdirectory)) return refused('SKILL_PATH_INVALID')
  const selected = subdirectory ? join(directory, subdirectory) : directory
  if (subdirectory) {
    let cursor = directory
    for (const part of subdirectory.split('/')) {
      cursor = join(cursor, part)
      const stat = lstatSync(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return refused('SKILL_LINK_REFUSED')
    }
  }
  const entries = readdirSync(selected, { withFileTypes: true })
  const pkg = json(selected, 'package.json')
  if (pkg && Object.hasOwn(pkg, 'agnes'))
    return { candidates: [], reason: 'SKILL_NATIVE_PACKAGE_USE_PLUGIN_INSTALL' }
  if (entries.some((entry) => entry.name === 'cordis.patch.yml') || (pkg && Object.hasOwn(pkg, 'dsh')))
    return { candidates: [], reason: 'SKILL_FOREIGN_RUNTIME_UNSUPPORTED' }
  if (entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile()))
    return supportedSkillDocument(selected)
      ? { directory: resolve(selected), candidates: [subdirectory ?? ''] }
      : { candidates: [], reason: 'SKILL_DOCUMENT_PROFILE_UNSUPPORTED' }
  const candidates: string[] = []
  let visited = 0
  const walk = (path: string, relative: string, depth: number) => {
    if (depth > 6) return
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (++visited > SKILL_BUNDLE_LIMITS.entries) return refused('SKILL_SIZE_LIMIT')
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (!isSkillBundlePath(name) || entry.isSymbolicLink()) continue
      if (entry.isFile() && entry.name === 'SKILL.md') {
        candidates.push(relative)
        if (candidates.length > 100) return refused('SKILL_SIZE_LIMIT')
      } else if (entry.isDirectory()) walk(join(path, entry.name), name, depth + 1)
    }
  }
  walk(selected, subdirectory ?? '', 0)
  return { candidates: candidates.sort() }
}
